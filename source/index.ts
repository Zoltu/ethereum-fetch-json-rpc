import { Bytes, Bytes32, Address, TransactionReceipt, IUnsignedTransaction, IOffChainTransaction, Rpc, IJsonRpcRequest, IJsonRpcError, IJsonRpcSuccess, isJsonRpcError, validateJsonRpcResponse, JsonRpcMethod, IOnChainTransaction, ISignedTransaction, BytesLike, AddressLike, JsonRpc } from '@zoltu/ethereum-types'
import { rlpEncode } from './vendor/rlp-encoder/index'
import { ErrorWithData } from './error-with-data'
export { ErrorWithData }
import { sleep } from './sleep'
import { stripLeadingZeros } from './utils'

type FetchResult = {
	readonly ok: boolean,
	readonly status: number,
	readonly statusText: string,
	json: () => Promise<any>,
	text: () => Promise<string>,
}
type FetchOptions = {
	method: string,
	body: string,
	headers: Record<string, string>,
}
type Fetch = (url: string, options: FetchOptions) => Promise<FetchResult>
type SignatureLike = {
	r: bigint,
	s: bigint,
	v: bigint,
}

export class FetchJsonRpc implements JsonRpc {
	private readonly chainId: Promise<number>
	public constructor(jsonRpcEndpoint: string, fetch: Fetch, getGasPriceInAttoeth?: () => Promise<bigint>)
	public constructor(jsonRpcEndpoint: string, fetch: Fetch, getGasPriceInAttoeth?: () => Promise<bigint>, getSignerAddress?: () => Promise<AddressLike>, signer?: (bytes: Bytes) => Promise<SignatureLike>, chainId?: number)
	public constructor(
		private readonly jsonRpcEndpoint: string,
		private readonly fetch: Fetch,
		getGasPriceInAttoeth?: () => Promise<bigint>,
		getSignerAddress?: () => Promise<AddressLike>,
		private readonly signer?: (bytes: Bytes) => Promise<SignatureLike>,
		chainId?: number
	) {
		this.coinbase = (getSignerAddress) ? async () => Address.fromByteArray(await getSignerAddress()) : this.makeRequest(Rpc.Eth.Coinbase.Request, Rpc.Eth.Coinbase.Response)
		this.getGasPrice = (getGasPriceInAttoeth) ? getGasPriceInAttoeth : this.makeRequest(Rpc.Eth.GasPrice.Request, Rpc.Eth.GasPrice.Response)
		this.chainId = (chainId !== undefined) ? Promise.resolve(chainId) : this.getChainId()
	}

	public readonly sendEth = async (destination: AddressLike, amount: bigint): Promise<TransactionReceipt> => await this.executeTransaction({ to: destination, value: amount })

	public readonly deployContract = async (bytecode: BytesLike, value?: bigint): Promise<Address> => (await this.executeTransaction({ to: null, data: bytecode, value: value })).contractAddress!

	public readonly onChainContractCall = async (transaction: Partial<IOnChainTransaction<AddressLike, BytesLike>> & { to: AddressLike, data: BytesLike }): Promise<TransactionReceipt> => this.executeTransaction(transaction)

	public readonly offChainContractCall = async (transaction: Partial<IOffChainTransaction<AddressLike, BytesLike>> & { to: AddressLike, data: BytesLike }): Promise<Bytes> => {
		const offChainTransaction: IOffChainTransaction<AddressLike, BytesLike> = {
			from: transaction.from || await this.coinbase(),
			to: transaction.to,
			value: transaction.value || 0n,
			data: transaction.data || new Bytes(),
			gasLimit: transaction.gasLimit || 1_000_000_000,
			gasPrice: transaction.gasPrice || await this.getGasPrice(),
		}
		return await this.call(offChainTransaction)
	}

	private readonly executeTransaction = async (transaction: Partial<IUnsignedTransaction<AddressLike, BytesLike>> & { to: AddressLike | null }): Promise<TransactionReceipt> => {
		const gasEstimatingTransaction: IOffChainTransaction<AddressLike, BytesLike> = {
			from: transaction.from || await this.coinbase(),
			to: transaction.to,
			value: transaction.value || 0n,
			data: transaction.data || new Bytes(),
			gasLimit: transaction.gasLimit || 1_000_000_000,
			gasPrice: transaction.gasPrice || await this.getGasPrice(),
		}
		const unsignedTransaction = {
			...gasEstimatingTransaction,
			gasLimit: transaction.gasLimit || await this.estimateGas(gasEstimatingTransaction),
			nonce: transaction.nonce || await this.getTransactionCount(gasEstimatingTransaction.from, 'pending'),
			chainId: await this.chainId,
		}
		let transactionHash: Bytes32
		if (this.signer === undefined) {
			transactionHash = await this.sendTransaction(unsignedTransaction)
		} else {
			const rlpEncodedUnsignedTransaction = this.rlpEncodeTransaction(unsignedTransaction)
			const signature = await this.signer(rlpEncodedUnsignedTransaction)
			const signedTransaction = {...unsignedTransaction, ...signature }
			const rlpEncodedSignedTransaction = this.rlpEncodeTransaction(signedTransaction)
			transactionHash = await this.sendRawTransaction(rlpEncodedSignedTransaction)
		}
		let receipt = await this.getTransactionReceipt(transactionHash)
		// TODO: find out if Parity, Geth or MM return a receipt with a null block anymore (docs suggest no)
		while (receipt === null || receipt.blockNumber === null) {
			await sleep(1000)
			receipt = await this.getTransactionReceipt(transactionHash)
		}
		if (!receipt.status) throw new Error(`Transaction mined, but failed.`)
		if (!receipt.contractAddress && !unsignedTransaction.to) throw new Error(`Contract deployment failed.  Contract address was null.`)
		return receipt
	}

	private readonly makeRequest = <
		// https://github.com/microsoft/TypeScript/issues/32976 TRequestConstructor should be constrained to constructors that take a string|number|null first parameter
		TRequestConstructor extends new (...args: any[]) => { wireEncode: () => IJsonRpcRequest<JsonRpcMethod, any[]> },
		TResponseConstructor extends new (rawResponse: IJsonRpcSuccess<any>) => { result: any },
		TRequest extends InstanceType<TRequestConstructor>,
		TResponse extends InstanceType<TResponseConstructor>,
		TResponseResult extends ResultType<TResponse>,
	>(Request: TRequestConstructor, Response: TResponseConstructor) => async (...args: DropFirst<ConstructorParameters<TRequestConstructor>>): Promise<TResponseResult> => {
		const request = new Request(null, ...args) as TRequest
		const rawRequest = request.wireEncode() as RawRequestType<TRequest>
		const rawResponse = await this.remoteProcedureCall(rawRequest) as PickFirst<ConstructorParameters<TResponseConstructor>>
		const response = new Response(rawResponse) as TResponse
		return response.result as TResponseResult
	}

	public readonly call = this.makeRequest(Rpc.Eth.Call.Request, Rpc.Eth.Call.Response)
	// see constructor
	public readonly coinbase: () => Promise<Address>
	public readonly estimateGas = this.makeRequest(Rpc.Eth.EstimateGas.Request, Rpc.Eth.EstimateGas.Response)
	public readonly getAccounts = this.makeRequest(Rpc.Eth.Accounts.Request, Rpc.Eth.Accounts.Response)
	public readonly getBalance = this.makeRequest(Rpc.Eth.GetBalance.Request, Rpc.Eth.GetBalance.Response)
	public readonly getBlockByHash = this.makeRequest(Rpc.Eth.GetBlockByHash.Request, Rpc.Eth.GetBlockByHash.Response)
	public readonly getBlockByNumber = this.makeRequest(Rpc.Eth.GetBlockByNumber.Request, Rpc.Eth.GetBlockByNumber.Response)
	public readonly getBlockNumber = this.makeRequest(Rpc.Eth.BlockNumber.Request, Rpc.Eth.BlockNumber.Response)
	public readonly getBlockTransactionCountByHash = this.makeRequest(Rpc.Eth.GetBlockTransactionCountByHash.Request, Rpc.Eth.GetBlockTransactionCountByHash.Response)
	public readonly getBlockTransactionCountByNumber = this.makeRequest(Rpc.Eth.GetBlockTransactionCountByNumber.Request, Rpc.Eth.GetBlockTransactionCountByNumber.Response)
	// see constructor
	public readonly getGasPrice: () => Promise<bigint>
	public readonly getChainId = this.makeRequest(Rpc.Eth.ChainId.Request, Rpc.Eth.ChainId.Response)
	public readonly getCode = this.makeRequest(Rpc.Eth.GetCode.Request, Rpc.Eth.GetCode.Response)
	public readonly getLogs = this.makeRequest(Rpc.Eth.GetLogs.Request, Rpc.Eth.GetLogs.Response)
	public readonly getStorageAt = this.makeRequest(Rpc.Eth.GetStorageAt.Request, Rpc.Eth.GetStorageAt.Response)
	public readonly getTransactionByBlockHashAndIndex = this.makeRequest(Rpc.Eth.GetTransactionByBlockHashAndIndex.Request, Rpc.Eth.GetTransactionByBlockHashAndIndex.Response)
	public readonly getTransactionByBlockNumberAndIndex = this.makeRequest(Rpc.Eth.GetTransactionByBlockNumberAndIndex.Request, Rpc.Eth.GetTransactionByBlockNumberAndIndex.Response)
	public readonly getTransactionByHash = this.makeRequest(Rpc.Eth.GetTransactionByHash.Request, Rpc.Eth.GetTransactionByHash.Response)
	public readonly getTransactionCount = this.makeRequest(Rpc.Eth.GetTransactionCount.Request, Rpc.Eth.GetTransactionCount.Response)
	// workaround for Parity returning partial transaction receipts before mining
	// public readonly getTransactionReceipt = this.makeRequest(Rpc.Eth.GetTransactionReceipt.Request, Rpc.Eth.GetTransactionReceipt.Response)
	public readonly getTransactionReceipt = async (transactionHash: ArrayLike<number> & {length:32}): Promise<TransactionReceipt | null> => {
		const request = new Rpc.Eth.GetTransactionReceipt.Request(null, transactionHash)
		const rawRequest = request.wireEncode()
		const rawResponse = await this.remoteProcedureCall(rawRequest)
		if (rawResponse.result === null || rawResponse.result.blockNumber === null || rawResponse.result.blockHash === null) return null
		const response = new Rpc.Eth.GetTransactionReceipt.Response(rawResponse)
		return response.result
	}
	public readonly getUncleByBlockHashAndIndex = this.makeRequest(Rpc.Eth.GetUncleByBlockHashAndIndex.Request, Rpc.Eth.GetUncleByBlockHashAndIndex.Response)
	public readonly getUncleByBlockNumberAndIndex = this.makeRequest(Rpc.Eth.GetUncleByBlockNumberAndIndex.Request, Rpc.Eth.GetUncleByBlockNumberAndIndex.Response)
	public readonly getUncleCountByBlockHash = this.makeRequest(Rpc.Eth.GetUncleCountByBlockHash.Request, Rpc.Eth.GetUncleCountByBlockHash.Response)
	public readonly getUncleCountByBlockNumber = this.makeRequest(Rpc.Eth.GetUncleCountByBlockNumber.Request, Rpc.Eth.GetUncleCountByBlockNumber.Response)
	public readonly getProtocolVersion = this.makeRequest(Rpc.Eth.ProtocolVersion.Request, Rpc.Eth.ProtocolVersion.Response)
	public readonly sendRawTransaction = this.makeRequest(Rpc.Eth.SendRawTransaction.Request, Rpc.Eth.SendRawTransaction.Response)
	public readonly sendTransaction = this.makeRequest(Rpc.Eth.SendTransaction.Request, Rpc.Eth.SendTransaction.Response)
	public readonly sign = this.makeRequest(Rpc.Eth.Sign.Request, Rpc.Eth.Sign.Response)
	public readonly syncing = this.makeRequest(Rpc.Eth.Syncing.Request, Rpc.Eth.Syncing.Response)

	public readonly remoteProcedureCall = async <
		TRawRequest extends IJsonRpcRequest<JsonRpcMethod, Array<any>>,
		TRawResponse extends IJsonRpcSuccess<any>
	>(request: TRawRequest): Promise<TRawResponse> => {
		const requestBodyJson = JSON.stringify(request)
		const response = await this.fetch(this.jsonRpcEndpoint, { method: 'POST', body: requestBodyJson, headers: { 'Content-Type': 'application/json' } })
		if (!response.ok) throw new ErrorWithData(`${response.status}: ${response.statusText}\n${response.text()}`, request)
		const responseBody: TRawResponse | IJsonRpcError = await response.json()
		validateJsonRpcResponse(responseBody)
		if (isJsonRpcError(responseBody)) throw new ErrorWithData(responseBody.error.message, request)
		return responseBody
	}

	private readonly rlpEncodeTransaction = (transaction: IUnsignedTransaction<AddressLike, BytesLike> | ISignedTransaction<AddressLike, BytesLike>): Bytes => {
		const toEncode = [
			stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.nonce)),
			stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.gasPrice)),
			stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.gasLimit)),
			stripLeadingZeros(transaction.to || new Uint8Array(0)),
			stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.value)),
			new Uint8Array(transaction.data),
		]
		if (!this.isSignedTransaction(transaction)) {
			toEncode.push(stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.chainId)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
		} else {
			toEncode.push(stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.v)))
			toEncode.push(stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.r)))
			toEncode.push(stripLeadingZeros(Bytes32.fromUnsignedInteger(transaction.s)))
		}
		return Bytes.fromByteArray(rlpEncode(toEncode))
	}

	private readonly isSignedTransaction = (transaction: IUnsignedTransaction<AddressLike, BytesLike> | ISignedTransaction<AddressLike, BytesLike>): transaction is ISignedTransaction<AddressLike, BytesLike> => (transaction as any).r !== undefined
}

type DropFirst<T extends any[]> = ((...t: T) => void) extends ((x: any, ...u: infer U) => void) ? U : never
type PickFirst<T extends any[]> = ((...t: T) => void) extends ((x: infer U, ...u: any[]) => void) ? U : never
type ResultType<T extends { result: unknown }> = T extends { result: infer R } ? R : never
type RawRequestType<T extends { wireEncode: () => IJsonRpcRequest<JsonRpcMethod, unknown[]> }> = T extends { wireEncode: () => infer R } ? R : never
