/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {
  Asset,
  generateKey,
  generateKeyFromPrivateKey,
  Note as NativeNote,
} from '@ironfish/rust-nodejs'
import { BufferMap } from 'buffer-map'
import { v4 as uuid } from 'uuid'
import { Assert } from '../assert'
import { Blockchain } from '../blockchain'
import { ChainProcessor } from '../chainProcessor'
import { isExpiredSequence } from '../consensus'
import { Event } from '../event'
import { Config } from '../fileStores'
import { createRootLogger, Logger } from '../logger'
import { MemPool } from '../memPool'
import { NoteHasher } from '../merkletree/hasher'
import { NoteWitness, Witness } from '../merkletree/witness'
import { Mutex } from '../mutex'
import { BlockHeader } from '../primitives/blockheader'
import { BurnDescription } from '../primitives/burnDescription'
import { MintDescription } from '../primitives/mintDescription'
import { Note } from '../primitives/note'
import { RawTransaction } from '../primitives/rawTransaction'
import { Transaction } from '../primitives/transaction'
import { IDatabaseTransaction } from '../storage/database/transaction'
import {
  AsyncUtils,
  BufferUtils,
  PromiseResolve,
  PromiseUtils,
  SetTimeoutToken,
} from '../utils'
import { WorkerPool } from '../workerPool'
import { DecryptedNote, DecryptNoteOptions } from '../workerPool/tasks/decryptNotes'
import { Account, AccountImport } from './account'
import { NotEnoughFundsError } from './errors'
import { MintAssetOptions } from './interfaces/mintAssetOptions'
import { validateAccount } from './validator'
import { AccountValue } from './walletdb/accountValue'
import { DecryptedNoteValue } from './walletdb/decryptedNoteValue'
import { TransactionValue } from './walletdb/transactionValue'
import { WalletDB } from './walletdb/walletdb'

const noteHasher = new NoteHasher()

export enum TransactionStatus {
  CONFIRMED = 'confirmed',
  EXPIRED = 'expired',
  PENDING = 'pending',
  UNCONFIRMED = 'unconfirmed',
  UNKNOWN = 'unknown',
}

export enum TransactionType {
  SEND = 'send',
  RECEIVE = 'receive',
  MINER = 'miner',
}

export class Wallet {
  readonly onAccountImported = new Event<[account: Account]>()
  readonly onAccountRemoved = new Event<[account: Account]>()
  readonly onBroadcastTransaction = new Event<[transaction: Transaction]>()
  readonly onTransactionCreated = new Event<[transaction: Transaction]>()

  scan: ScanState | null = null
  updateHeadState: ScanState | null = null

  protected readonly accounts = new Map<string, Account>()
  readonly walletDb: WalletDB
  readonly logger: Logger
  readonly workerPool: WorkerPool
  readonly chain: Blockchain
  readonly chainProcessor: ChainProcessor
  private readonly config: Config

  protected rebroadcastAfter: number
  protected defaultAccount: string | null = null
  protected isStarted = false
  protected isOpen = false
  protected eventLoopTimeout: SetTimeoutToken | null = null
  private readonly createTransactionMutex: Mutex
  private readonly eventLoopAbortController: AbortController
  private eventLoopPromise: Promise<void> | null = null
  private eventLoopResolve: PromiseResolve<void> | null = null

  constructor({
    chain,
    config,
    database,
    logger = createRootLogger(),
    rebroadcastAfter,
    workerPool,
  }: {
    chain: Blockchain
    config: Config
    database: WalletDB
    logger?: Logger
    rebroadcastAfter?: number
    workerPool: WorkerPool
  }) {
    this.chain = chain
    this.config = config
    this.logger = logger.withTag('accounts')
    this.walletDb = database
    this.workerPool = workerPool
    this.rebroadcastAfter = rebroadcastAfter ?? 10
    this.createTransactionMutex = new Mutex()
    this.eventLoopAbortController = new AbortController()

    this.chainProcessor = new ChainProcessor({
      logger: this.logger,
      chain: chain,
      head: null,
    })

    this.chainProcessor.onAdd.on(async (header) => {
      this.logger.debug(`AccountHead ADD: ${Number(header.sequence) - 1} => ${header.sequence}`)

      await this.connectBlock(header)
    })

    this.chainProcessor.onRemove.on(async (header) => {
      this.logger.debug(`AccountHead DEL: ${header.sequence} => ${Number(header.sequence) - 1}`)

      await this.disconnectBlock(header)
    })
  }

  async updateHead(): Promise<void> {
    if (this.scan || this.updateHeadState || this.accounts.size === 0) {
      return
    }

    // TODO: this isn't right, as the scan state doesn't get its sequence or
    // endSequence set properly
    const scan = new ScanState()
    this.updateHeadState = scan

    try {
      const { hashChanged } = await this.chainProcessor.update({
        signal: scan.abortController.signal,
      })

      if (hashChanged) {
        this.logger.debug(
          `Updated Accounts Head: ${String(this.chainProcessor.hash?.toString('hex'))}`,
        )
      }
    } finally {
      scan.signalComplete()
      this.updateHeadState = null
    }
  }

  async shouldRescan(): Promise<boolean> {
    if (this.scan) {
      return false
    }

    for (const account of this.accounts.values()) {
      if (!(await this.isAccountUpToDate(account))) {
        return true
      }
    }

    return false
  }

  async open(): Promise<void> {
    if (this.isOpen) {
      return
    }

    this.isOpen = true
    await this.walletDb.open()
    await this.load()
  }

  private async load(): Promise<void> {
    for await (const accountValue of this.walletDb.loadAccounts()) {
      const account = new Account({
        ...accountValue,
        walletDb: this.walletDb,
      })

      this.accounts.set(account.id, account)
    }

    const meta = await this.walletDb.loadAccountsMeta()
    this.defaultAccount = meta.defaultAccountId

    this.chainProcessor.hash = await this.getLatestHeadHash()
  }

  private unload(): void {
    this.accounts.clear()

    this.defaultAccount = null
    this.chainProcessor.hash = null
  }

  async close(): Promise<void> {
    if (!this.isOpen) {
      return
    }

    this.isOpen = false
    await this.walletDb.close()
    this.unload()
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return
    }
    this.isStarted = true

    if (this.chainProcessor.hash) {
      const hasHeadBlock = await this.chain.hasBlock(this.chainProcessor.hash)

      if (!hasHeadBlock) {
        this.logger.error(
          `Resetting accounts database because accounts head was not found in chain: ${this.chainProcessor.hash.toString(
            'hex',
          )}`,
        )
        await this.reset()
      }
    }

    if (!this.scan && (await this.shouldRescan())) {
      void this.scanTransactions()
    }

    void this.eventLoop()
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return
    }
    this.isStarted = false

    if (this.eventLoopTimeout) {
      clearTimeout(this.eventLoopTimeout)
    }

    await Promise.all([this.scan?.abort(), this.updateHeadState?.abort()])
    this.eventLoopAbortController.abort()

    await this.eventLoopPromise
  }

  async eventLoop(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    const [promise, resolve] = PromiseUtils.split<void>()
    this.eventLoopPromise = promise
    this.eventLoopResolve = resolve

    await this.updateHead()
    await this.expireTransactions()
    await this.rebroadcastTransactions()
    await this.cleanupDeletedAccounts()

    if (this.isStarted) {
      this.eventLoopTimeout = setTimeout(() => void this.eventLoop(), 1000)
    }

    resolve()
    this.eventLoopPromise = null
    this.eventLoopResolve = null
  }

  async reset(): Promise<void> {
    await this.resetAccounts()

    this.chainProcessor.hash = null
  }

  private async resetAccounts(tx?: IDatabaseTransaction): Promise<void> {
    for (const account of this.accounts.values()) {
      await account.reset(tx)
    }
  }

  async decryptNotes(
    transaction: Transaction,
    initialNoteIndex: number | null,
    accounts?: Array<Account>,
  ): Promise<Map<string, Array<DecryptedNote>>> {
    const accountsToCheck =
      accounts ||
      (await AsyncUtils.filter(
        this.listAccounts(),
        async (a) => await this.isAccountUpToDate(a),
      ))

    const decryptedNotesByAccountId = new Map<string, Array<DecryptedNote>>()

    const batchSize = 20
    for (const account of accountsToCheck) {
      const decryptedNotes = []
      let decryptNotesPayloads = []
      let currentNoteIndex = initialNoteIndex

      for (const note of transaction.notes) {
        decryptNotesPayloads.push({
          serializedNote: note.serialize(),
          incomingViewKey: account.incomingViewKey,
          outgoingViewKey: account.outgoingViewKey,
          spendingKey: account.spendingKey,
          currentNoteIndex,
        })

        if (currentNoteIndex) {
          currentNoteIndex++
        }

        if (decryptNotesPayloads.length >= batchSize) {
          const decryptedNotesBatch = await this.decryptNotesFromTransaction(
            decryptNotesPayloads,
          )
          decryptedNotes.push(...decryptedNotesBatch)
          decryptNotesPayloads = []
        }
      }

      if (decryptNotesPayloads.length) {
        const decryptedNotesBatch = await this.decryptNotesFromTransaction(decryptNotesPayloads)
        decryptedNotes.push(...decryptedNotesBatch)
      }

      if (decryptedNotes.length) {
        decryptedNotesByAccountId.set(account.id, decryptedNotes)
      }
    }

    return decryptedNotesByAccountId
  }

  private async decryptNotesFromTransaction(
    decryptNotesPayloads: Array<DecryptNoteOptions>,
  ): Promise<Array<DecryptedNote>> {
    const decryptedNotes = []
    const response = await this.workerPool.decryptNotes(decryptNotesPayloads)
    for (const decryptedNote of response) {
      if (decryptedNote) {
        decryptedNotes.push(decryptedNote)
      }
    }

    return decryptedNotes
  }

  async connectBlock(blockHeader: BlockHeader, scan?: ScanState): Promise<void> {
    const accounts = await AsyncUtils.filter(this.listAccounts(), async (account) => {
      const accountHead = await account.getHead()

      if (!accountHead) {
        return blockHeader.sequence === 1
      } else {
        return BufferUtils.equalsNullable(accountHead.hash, blockHeader.previousBlockHash)
      }
    })

    for (const account of accounts) {
      await this.walletDb.db.transaction(async (tx) => {
        const transactions = await this.chain.getBlockTransactions(blockHeader)

        for (const { transaction, initialNoteIndex } of transactions) {
          if (scan && scan.isAborted) {
            scan.signalComplete()
            this.scan = null
            return
          }

          const decryptedNotesByAccountId = await this.decryptNotes(
            transaction,
            initialNoteIndex,
            [account],
          )

          const decryptedNotes = decryptedNotesByAccountId.get(account.id)

          if (!decryptedNotes) {
            continue
          }

          await account.connectTransaction(blockHeader, transaction, decryptedNotes, tx)

          scan?.signal(blockHeader.sequence)
        }

        await account.updateHead({ hash: blockHeader.hash, sequence: blockHeader.sequence }, tx)
      })
    }
  }

  async disconnectBlock(header: BlockHeader): Promise<void> {
    const accounts = await AsyncUtils.filter(this.listAccounts(), async (account) => {
      const accountHead = await account.getHead()

      return BufferUtils.equalsNullable(accountHead?.hash ?? null, header.hash)
    })

    for (const account of accounts) {
      await this.walletDb.db.transaction(async (tx) => {
        const transactions = await this.chain.getBlockTransactions(header)

        for (const { transaction } of transactions.slice().reverse()) {
          await account.disconnectTransaction(header, transaction, tx)

          if (transaction.isMinersFee()) {
            await account.deleteTransaction(transaction, tx)
          }
        }

        await account.updateHead(
          { hash: header.previousBlockHash, sequence: header.sequence - 1 },
          tx,
        )
      })
    }
  }

  async addPendingTransaction(transaction: Transaction): Promise<void> {
    const accounts = await AsyncUtils.filter(
      this.listAccounts(),
      async (account) => !(await account.hasTransaction(transaction.hash())),
    )

    if (accounts.length === 0) {
      return
    }

    const decryptedNotesByAccountId = await this.decryptNotes(transaction, null, accounts)

    for (const [accountId, decryptedNotes] of decryptedNotesByAccountId) {
      const account = this.accounts.get(accountId)

      if (!account) {
        continue
      }

      await account.addPendingTransaction(transaction, decryptedNotes, this.chain.head.sequence)
    }
  }

  async scanTransactions(fromHash?: Buffer): Promise<void> {
    if (!this.isOpen) {
      throw new Error('Cannot start a scan if accounts are not loaded')
    }

    if (this.scan) {
      this.logger.info('Skipping Scan, already scanning.')
      return
    }

    const scan = new ScanState()
    this.scan = scan

    // If we are updating the account head, we need to wait until its finished
    // but setting this.scan is our lock so updating the head doesn't run again
    await this.updateHeadState?.wait()

    const startHash = await this.getEarliestHeadHash()

    // Priority: fromHeader > startHeader > genesisBlock
    const beginHash = fromHash ? fromHash : startHash ? startHash : this.chain.genesis.hash
    const beginHeader = await this.chain.getHeader(beginHash)

    Assert.isNotNull(
      beginHeader,
      `scanTransactions: No header found for start hash ${beginHash.toString('hex')}`,
    )

    const endHash = this.chainProcessor.hash || this.chain.head.hash
    const endHeader = await this.chain.getHeader(endHash)

    Assert.isNotNull(
      endHeader,
      `scanTransactions: No header found for end hash ${endHash.toString('hex')}`,
    )

    scan.sequence = beginHeader.sequence
    scan.endSequence = endHeader.sequence

    if (scan.isAborted || beginHash.equals(endHash)) {
      scan.signalComplete()
      this.scan = null
      return
    }

    this.logger.info(
      `Scan starting from earliest found account head hash: ${beginHash.toString('hex')}`,
    )

    // Go through every transaction in the chain and add notes that we can decrypt
    for await (const blockHeader of this.chain.iterateBlockHeaders(
      beginHash,
      endHash,
      undefined,
      false,
    )) {
      await this.connectBlock(blockHeader, scan)
    }

    if (this.chainProcessor.hash === null) {
      const latestHeadHash = await this.getLatestHeadHash()
      Assert.isNotNull(latestHeadHash, `scanTransactions: No latest head hash found`)

      this.chainProcessor.hash = latestHeadHash
    }

    this.logger.info(
      `Finished scanning for transactions after ${Math.floor(
        (Date.now() - scan.startedAt) / 1000,
      )} seconds`,
    )

    scan.signalComplete()
    this.scan = null
  }

  async *getBalances(
    account: Account,
    confirmations?: number,
  ): AsyncGenerator<{
    assetId: Buffer
    unconfirmed: bigint
    unconfirmedCount: number
    confirmed: bigint
    blockHash: Buffer | null
    sequence: number | null
  }> {
    confirmations = confirmations ?? this.config.get('confirmations')

    this.assertHasAccount(account)

    for await (const balance of account.getBalances(confirmations)) {
      yield balance
    }
  }

  async getBalance(
    account: Account,
    assetId: Buffer,
    options?: { confirmations?: number },
  ): Promise<{
    unconfirmedCount: number
    unconfirmed: bigint
    confirmed: bigint
    blockHash: Buffer | null
    sequence: number | null
  }> {
    const confirmations = options?.confirmations ?? this.config.get('confirmations')

    this.assertHasAccount(account)

    return account.getBalance(assetId, confirmations)
  }

  private async *getUnspentNotes(
    account: Account,
    assetId: Buffer,
    options?: {
      confirmations?: number
    },
  ): AsyncGenerator<DecryptedNoteValue & { hash: Buffer }> {
    const confirmations = options?.confirmations ?? this.config.get('confirmations')

    for await (const decryptedNote of account.getUnspentNotes(assetId, {
      confirmations,
    })) {
      yield decryptedNote
    }
  }

  async send(
    memPool: MemPool,
    sender: Account,
    receives: {
      publicAddress: string
      amount: bigint
      memo: string
      assetId: Buffer
    }[],
    fee: bigint,
    expirationDelta: number,
    expiration?: number | null,
  ): Promise<Transaction> {
    const raw = await this.createTransaction(
      sender,
      receives,
      [],
      [],
      fee,
      expirationDelta,
      expiration,
    )

    return this.postTransaction(raw, memPool)
  }

  async mint(
    memPool: MemPool,
    account: Account,
    options: MintAssetOptions,
  ): Promise<Transaction> {
    let asset: Asset
    if ('assetId' in options) {
      const record = await this.chain.getAssetById(options.assetId)
      if (!record) {
        throw new Error(
          `Asset not found. Cannot mint for identifier '${options.assetId.toString('hex')}'`,
        )
      }

      asset = new Asset(
        account.spendingKey,
        record.name.toString('utf8'),
        record.metadata.toString('utf8'),
      )
      // Verify the stored asset produces the same identfier before building a transaction
      if (!options.assetId.equals(asset.id())) {
        throw new Error(`Unauthorized to mint for asset '${options.assetId.toString('hex')}'`)
      }
    } else {
      asset = new Asset(account.spendingKey, options.name, options.metadata)
    }

    const raw = await this.createTransaction(
      account,
      [],
      [{ asset, value: options.value }],
      [],
      options.fee,
      options.expirationDelta,
      options.expiration,
    )

    return this.postTransaction(raw, memPool)
  }

  async burn(
    memPool: MemPool,
    account: Account,
    assetId: Buffer,
    value: bigint,
    fee: bigint,
    expirationDelta: number,
    expiration?: number,
  ): Promise<Transaction> {
    const raw = await this.createTransaction(
      account,
      [],
      [],
      [{ assetId, value }],
      fee,
      expirationDelta,
      expiration,
    )

    return this.postTransaction(raw, memPool)
  }

  async createTransaction(
    sender: Account,
    receives: {
      publicAddress: string
      amount: bigint
      memo: string
      assetId: Buffer
    }[],
    mints: MintDescription[],
    burns: BurnDescription[],
    fee: bigint,
    expirationDelta: number,
    expiration?: number | null,
  ): Promise<RawTransaction> {
    const heaviestHead = this.chain.head
    if (heaviestHead === null) {
      throw new Error('You must have a genesis block to create a transaction')
    }

    expiration = expiration ?? heaviestHead.sequence + expirationDelta

    if (isExpiredSequence(expiration, this.chain.head.sequence)) {
      throw new Error('Invalid expiration sequence for transaction')
    }

    const unlock = await this.createTransactionMutex.lock()

    try {
      this.assertHasAccount(sender)

      if (!(await this.isAccountUpToDate(sender))) {
        throw new Error('Your account must finish scanning before sending a transaction.')
      }

      const raw = new RawTransaction()
      raw.spendingKey = sender.spendingKey
      raw.expiration = expiration
      raw.mints = mints
      raw.burns = burns
      raw.fee = fee

      for (const receive of receives) {
        const note = new NativeNote(
          receive.publicAddress,
          receive.amount,
          receive.memo,
          receive.assetId,
          sender.publicAddress,
        )

        raw.receives.push({ note: new Note(note.serialize()) })
      }

      await this.fund(raw, {
        fee: fee,
        account: sender,
      })

      return raw
    } finally {
      unlock()
    }
  }

  async postTransaction(raw: RawTransaction, memPool: MemPool): Promise<Transaction> {
    const transaction = await this.workerPool.postTransaction(raw)

    const verify = this.chain.verifier.verifyCreatedTransaction(transaction)
    if (!verify.valid) {
      throw new Error(`Invalid transaction, reason: ${String(verify.reason)}`)
    }

    await this.addPendingTransaction(transaction)
    memPool.acceptTransaction(transaction)
    this.broadcastTransaction(transaction)
    this.onTransactionCreated.emit(transaction)

    return transaction
  }

  async fund(
    raw: RawTransaction,
    options: {
      fee: bigint
      account: Account
    },
  ): Promise<void> {
    const needed = this.buildAmountsNeeded(raw, {
      fee: options.fee,
    })

    const spends = await this.createSpends(options.account, needed)

    for (const spend of spends) {
      const witness = new Witness(
        spend.witness.treeSize(),
        spend.witness.rootHash,
        spend.witness.authenticationPath,
        noteHasher,
      )

      raw.spends.push({
        note: spend.note,
        witness: witness,
      })
    }
  }

  private buildAmountsNeeded(
    raw: RawTransaction,
    options: {
      fee: bigint
    },
  ): BufferMap<bigint> {
    const amountsNeeded = new BufferMap<bigint>()
    amountsNeeded.set(Asset.nativeId(), options.fee)

    for (const receive of raw.receives) {
      const currentAmount = amountsNeeded.get(receive.note.assetId()) ?? BigInt(0)
      amountsNeeded.set(receive.note.assetId(), currentAmount + receive.note.value())
    }

    for (const burn of raw.burns) {
      const currentAmount = amountsNeeded.get(burn.assetId) ?? BigInt(0)
      amountsNeeded.set(burn.assetId, currentAmount + burn.value)
    }

    return amountsNeeded
  }

  private async createSpends(
    sender: Account,
    amountsNeeded: BufferMap<bigint>,
  ): Promise<Array<{ note: Note; witness: NoteWitness }>> {
    const notesToSpend: Array<{ note: Note; witness: NoteWitness }> = []

    for (const [assetId, amountNeeded] of amountsNeeded.entries()) {
      const { amount, notes } = await this.createSpendsForAsset(sender, assetId, amountNeeded)

      if (amount < amountNeeded) {
        throw new NotEnoughFundsError(assetId, amount, amountNeeded)
      }

      notesToSpend.push(...notes)
    }

    return notesToSpend
  }

  async createSpendsForAsset(
    sender: Account,
    assetId: Buffer,
    amountNeeded: bigint,
  ): Promise<{ amount: bigint; notes: Array<{ note: Note; witness: NoteWitness }> }> {
    let amount = BigInt(0)
    const notes: Array<{ note: Note; witness: NoteWitness }> = []

    for await (const unspentNote of this.getUnspentNotes(sender, assetId)) {
      if (unspentNote.note.value() <= BigInt(0)) {
        continue
      }

      Assert.isNotNull(unspentNote.index)
      Assert.isNotNull(unspentNote.nullifier)

      if (await this.checkNoteOnChainAndRepair(sender, unspentNote)) {
        continue
      }

      // Try creating a witness from the note
      const witness = await this.chain.notes.witness(unspentNote.index)

      if (witness === null) {
        this.logger.debug(`Could not create a witness for note with index ${unspentNote.index}`)
        continue
      }

      this.logger.debug(
        `Accounts: spending note ${unspentNote.index} ${unspentNote.hash.toString(
          'hex',
        )} ${unspentNote.note.value()}`,
      )

      // Otherwise, push the note into the list of notes to spend
      notes.push({ note: unspentNote.note, witness })
      amount += unspentNote.note.value()

      if (amount >= amountNeeded) {
        break
      }
    }

    return { amount, notes }
  }

  /**
   * Checks if a note is already on the chain when trying to spend it
   *
   * This function should be deleted once the wallet is detached from the chain,
   * either way. It shouldn't be neccessary. It's just a hold over function to
   * sanity check from wallet 1.0.
   *
   * @returns true if the note is on the chain already
   */
  private async checkNoteOnChainAndRepair(
    sender: Account,
    unspentNote: DecryptedNoteValue & { hash: Buffer },
  ): Promise<boolean> {
    if (!unspentNote.nullifier) {
      return false
    }

    const spent = await this.chain.nullifiers.contains(unspentNote.nullifier)

    if (!spent) {
      return false
    }

    this.logger.debug(
      `Note was marked unspent, but nullifier found in tree: ${unspentNote.nullifier.toString(
        'hex',
      )}`,
    )

    // Update our map so this doesn't happen again
    const noteMapValue = await sender.getDecryptedNote(unspentNote.hash)

    if (noteMapValue) {
      this.logger.debug(`Unspent note has index ${String(noteMapValue.index)}`)
      await this.walletDb.saveDecryptedNote(sender, unspentNote.hash, {
        ...noteMapValue,
        spent: true,
      })
    }

    return true
  }

  broadcastTransaction(transaction: Transaction): void {
    this.onBroadcastTransaction.emit(transaction)
  }

  async rebroadcastTransactions(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    if (!this.chain.synced) {
      return
    }

    if (this.chainProcessor.hash === null) {
      return
    }

    const head = await this.chain.getHeader(this.chainProcessor.hash)

    if (head === null) {
      return
    }

    for (const account of this.accounts.values()) {
      if (this.eventLoopAbortController.signal.aborted) {
        return
      }

      for await (const transactionInfo of account.getPendingTransactions(head.sequence)) {
        if (this.eventLoopAbortController.signal.aborted) {
          return
        }

        const { transaction, blockHash, submittedSequence } = transactionInfo
        const transactionHash = transaction.hash()

        // Skip transactions that are already added to a block
        if (blockHash) {
          continue
        }

        // TODO: This algorithm suffers a deanonymization attack where you can
        // watch to see what transactions node continuously send out, then you can
        // know those transactions are theres. This should be randomized and made
        // less, predictable later to help prevent that attack.
        if (head.sequence - submittedSequence < this.rebroadcastAfter) {
          continue
        }

        let isValid = true
        await this.walletDb.db.transaction(async (tx) => {
          const verify = await this.chain.verifier.verifyTransactionAdd(transaction)

          // We still update this even if it's not valid to prevent constantly
          // reprocessing valid transaction every block. Give them a few blocks to
          // try to become valid.
          await this.walletDb.saveTransaction(
            account,
            transactionHash,
            {
              ...transactionInfo,
              submittedSequence: head.sequence,
            },
            tx,
          )

          if (!verify.valid) {
            isValid = false
            this.logger.debug(
              `Ignoring invalid transaction during rebroadcast ${transactionHash.toString(
                'hex',
              )}, reason ${String(verify.reason)} seq: ${head.sequence}`,
            )
          }
        })

        if (!isValid) {
          continue
        }
        this.broadcastTransaction(transaction)
      }
    }
  }

  async expireTransactions(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    if (!this.chain.synced) {
      return
    }

    if (this.chainProcessor.hash === null) {
      return
    }

    const head = await this.chain.getHeader(this.chainProcessor.hash)

    if (head === null) {
      return
    }

    for (const account of this.accounts.values()) {
      if (this.eventLoopAbortController.signal.aborted) {
        return
      }

      for await (const { transaction } of account.getExpiredTransactions(head.sequence)) {
        if (this.eventLoopAbortController.signal.aborted) {
          return
        }

        await account.expireTransaction(transaction)
      }
    }
  }

  async getTransactionStatus(
    account: Account,
    transaction: TransactionValue,
    options?: {
      headSequence?: number | null
      confirmations?: number
    },
    tx?: IDatabaseTransaction,
  ): Promise<TransactionStatus> {
    const confirmations = options?.confirmations ?? this.config.get('confirmations')

    const headSequence = options?.headSequence ?? (await account.getHead(tx))?.sequence

    if (!headSequence) {
      return TransactionStatus.UNKNOWN
    }

    if (transaction.sequence) {
      const isConfirmed = headSequence - transaction.sequence >= confirmations

      return isConfirmed ? TransactionStatus.CONFIRMED : TransactionStatus.UNCONFIRMED
    } else {
      const isExpired = isExpiredSequence(transaction.transaction.expiration(), headSequence)

      return isExpired ? TransactionStatus.EXPIRED : TransactionStatus.PENDING
    }
  }

  async getTransactionType(
    account: Account,
    transaction: TransactionValue,
    tx?: IDatabaseTransaction,
  ): Promise<TransactionType> {
    if (transaction.transaction.isMinersFee()) {
      return TransactionType.MINER
    }

    let send = false

    for (const spend of transaction.transaction.spends) {
      if ((await account.getNoteHash(spend.nullifier, tx)) !== null) {
        send = true
        break
      }
    }

    return send ? TransactionType.SEND : TransactionType.RECEIVE
  }

  async createAccount(name: string, setDefault = false): Promise<Account> {
    if (this.getAccountByName(name)) {
      throw new Error(`Account already exists with the name ${name}`)
    }

    const key = generateKey()

    const account = new Account({
      id: uuid(),
      name,
      incomingViewKey: key.incoming_view_key,
      outgoingViewKey: key.outgoing_view_key,
      publicAddress: key.public_address,
      spendingKey: key.spending_key,
      walletDb: this.walletDb,
    })

    await this.walletDb.db.transaction(async (tx) => {
      await this.walletDb.setAccount(account, tx)
      await this.skipRescan(account, tx)
    })

    this.accounts.set(account.id, account)

    if (setDefault) {
      await this.setDefaultAccount(account.name)
    }

    return account
  }

  async skipRescan(account: Account, tx?: IDatabaseTransaction): Promise<void> {
    const hash = this.chainProcessor.hash
    const sequence = this.chainProcessor.sequence

    if (hash === null || sequence === null) {
      await account.updateHead(null, tx)
    } else {
      await account.updateHead({ hash, sequence }, tx)
    }
  }

  async importAccount(toImport: AccountImport): Promise<Account> {
    if (toImport.name && this.getAccountByName(toImport.name)) {
      throw new Error(`Account already exists with the name ${toImport.name}`)
    }

    if (this.listAccounts().find((a) => toImport.spendingKey === a.spendingKey)) {
      throw new Error(`Account already exists with provided spending key`)
    }

    const key = generateKeyFromPrivateKey(toImport.spendingKey)

    const accountValue: AccountValue = {
      ...toImport,
      id: uuid(),
      incomingViewKey: key.incoming_view_key,
      outgoingViewKey: key.outgoing_view_key,
      publicAddress: key.public_address,
    }

    validateAccount(accountValue)

    const account = new Account({
      ...accountValue,
      walletDb: this.walletDb,
    })

    await this.walletDb.db.transaction(async (tx) => {
      await this.walletDb.setAccount(account, tx)
      await account.updateHead(null, tx)
    })

    this.accounts.set(account.id, account)
    this.onAccountImported.emit(account)

    return account
  }

  listAccounts(): Account[] {
    return Array.from(this.accounts.values())
  }

  accountExists(name: string): boolean {
    return this.getAccountByName(name) !== null
  }

  async removeAccount(name: string): Promise<void> {
    const account = this.getAccountByName(name)
    if (!account) {
      return
    }

    await this.walletDb.db.transaction(async (tx) => {
      if (account.id === this.defaultAccount) {
        await this.walletDb.setDefaultAccount(null, tx)
        this.defaultAccount = null
      }

      await this.walletDb.removeAccount(account, tx)
      await this.walletDb.removeHead(account, tx)
    })

    this.accounts.delete(account.id)
    this.onAccountRemoved.emit(account)
  }

  async cleanupDeletedAccounts(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    if (this.scan || this.updateHeadState) {
      return
    }

    await this.walletDb.cleanupDeletedAccounts(this.eventLoopAbortController.signal)
  }

  get hasDefaultAccount(): boolean {
    return !!this.defaultAccount
  }

  /** Set or clear the default account */
  async setDefaultAccount(name: string | null, tx?: IDatabaseTransaction): Promise<void> {
    let next = null

    if (name) {
      next = this.getAccountByName(name)

      if (!next) {
        throw new Error(`No account found with name ${name}`)
      }

      if (this.defaultAccount === next.id) {
        return
      }
    }

    const nextId = next ? next.id : null
    await this.walletDb.setDefaultAccount(nextId, tx)
    this.defaultAccount = nextId
  }

  getAccountByName(name: string): Account | null {
    for (const account of this.accounts.values()) {
      if (name === account.name) {
        return account
      }
    }
    return null
  }

  getAccount(id: string): Account | null {
    const account = this.accounts.get(id)

    if (account) {
      return account
    }

    return null
  }

  getDefaultAccount(): Account | null {
    if (!this.defaultAccount) {
      return null
    }

    return this.getAccount(this.defaultAccount)
  }

  async getEarliestHeadHash(): Promise<Buffer | null> {
    let earliestHead = null
    for (const account of this.accounts.values()) {
      const head = await account.getHead()

      if (!head) {
        return null
      }

      if (!earliestHead || earliestHead.sequence > head.sequence) {
        earliestHead = head
      }
    }

    return earliestHead ? earliestHead.hash : null
  }

  async getLatestHeadHash(): Promise<Buffer | null> {
    let latestHead = null

    for (const account of this.accounts.values()) {
      const head = await account.getHead()

      if (!head) {
        continue
      }

      if (!latestHead || latestHead.sequence < head.sequence) {
        latestHead = head
      }
    }

    return latestHead ? latestHead.hash : null
  }

  async isAccountUpToDate(account: Account): Promise<boolean> {
    const head = await account.getHead()
    Assert.isNotUndefined(
      head,
      `isAccountUpToDate: No head hash found for account ${account.displayName}`,
    )

    return BufferUtils.equalsNullable(head?.hash ?? null, this.chainProcessor.hash)
  }

  protected assertHasAccount(account: Account): void {
    if (!this.accountExists(account.name)) {
      throw new Error(`No account found with name ${account.name}`)
    }
  }

  protected assertNotHasAccount(account: Account): void {
    if (this.accountExists(account.name)) {
      throw new Error(`No account found with name ${account.name}`)
    }
  }
}

export class ScanState {
  onTransaction = new Event<[sequence: number, endSequence: number]>()

  sequence = -1
  endSequence = -1

  readonly startedAt: number
  readonly abortController: AbortController
  private runningPromise: Promise<void>
  private runningResolve: PromiseResolve<void>

  constructor() {
    const [promise, resolve] = PromiseUtils.split<void>()
    this.runningPromise = promise
    this.runningResolve = resolve

    this.abortController = new AbortController()
    this.startedAt = Date.now()
  }

  get isAborted(): boolean {
    return this.abortController.signal.aborted
  }

  signal(sequence: number): void {
    this.sequence = sequence
    this.onTransaction.emit(sequence, this.endSequence)
  }

  signalComplete(): void {
    this.runningResolve()
  }

  async abort(): Promise<void> {
    this.abortController.abort()
    return this.wait()
  }

  wait(): Promise<void> {
    return this.runningPromise
  }
}
