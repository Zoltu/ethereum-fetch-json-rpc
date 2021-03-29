import { Bytes, TransactionReceipt, IUnsignedTransaction, IOffChainTransaction, Rpc, IJsonRpcRequest, IJsonRpcError, IJsonRpcSuccess, isJsonRpcError, validateJsonRpcResponse, JsonRpcMethod, IOnChainTransaction, ISignedTransaction, JsonRpc } from '@zoltu/ethereum-types'
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
	yParity: 'even' | 'odd',
}

export interface FetchJsonRpcOptions {
	gasPriceInAttoethProvider?: FetchJsonRpc['gasPriceInAttoethProvider']
	gasLimitProvider?: FetchJsonRpc['gasLimitProvider']
	addressProvider?: FetchJsonRpc['addressProvider']
	signatureProvider?: FetchJsonRpc['signatureProvider']
	chainId?: bigint
}

export class FetchJsonRpc implements JsonRpc {
	public readonly gasPriceInAttoethProvider?: () => Promise<bigint>
	public readonly gasLimitProvider: (transaction: IOffChainTransaction, estimator: (transaction: IOffChainTransaction) => Promise<bigint>) => Promise<bigint>
	public readonly addressProvider?: () => Promise<bigint>
	public readonly signatureProvider?: (bytes: Bytes) => Promise<SignatureLike>
	private readonly chainId: Promise<bigint>

	public constructor(
		public readonly jsonRpcEndpoint: string,
		public readonly fetch: Fetch,
		options: FetchJsonRpcOptions,
	) {
		this.gasPriceInAttoethProvider = options.gasPriceInAttoethProvider
		this.gasLimitProvider = options.gasLimitProvider || (async (transaction, estimator) => await estimator(transaction))
		this.addressProvider = options.addressProvider
		this.signatureProvider = options.signatureProvider
		this.chainId = (options.chainId !== undefined) ? Promise.resolve(options.chainId) : this.getChainId()
		this.coinbase = (this.addressProvider) ? this.addressProvider : this.makeRequest(Rpc.Eth.Coinbase.Request, Rpc.Eth.Coinbase.Response)
		// necessary to capture value for async call, since readonly modifier doesn't take effect until after constructor
		const getSignerAddress = this.addressProvider
		this.getAccounts = (getSignerAddress !== undefined) ? async () => [await getSignerAddress()] : this.makeRequest(Rpc.Eth.Accounts.Request, Rpc.Eth.Accounts.Response)
		this.getGasPrice = (this.gasPriceInAttoethProvider) ? this.gasPriceInAttoethProvider : this.makeRequest(Rpc.Eth.GasPrice.Request, Rpc.Eth.GasPrice.Response)

		// silence NodeJS/Chrome warnings about unhandled rejections when we pre-fetch
		this.chainId.catch(() => {})
	}

	public readonly sendEth = async (destination: bigint, amount: bigint): Promise<TransactionReceipt> => await this.executeTransaction({ to: destination, value: amount })

	public readonly deployContract = async (bytecode: Uint8Array, value?: bigint): Promise<bigint> => (await this.executeTransaction({ to: null, data: bytecode, value: value })).contractAddress!

	public readonly onChainContractCall = async (transaction: PartiallyRequired<IOnChainTransaction, 'to'|'data'>): Promise<TransactionReceipt> => this.executeTransaction(transaction)

	public readonly offChainContractCall = async (transaction: PartiallyRequired<IOffChainTransaction, 'to'|'data'>): Promise<Bytes> => {
		const offChainTransaction: IOffChainTransaction = {
			from: transaction.from !== undefined ? transaction.from : await this.coinbase().catch(() => null) || 0n,
			to: transaction.to,
			value: transaction.value || 0n,
			data: transaction.data || new Bytes(),
			gasLimit: transaction.gasLimit || 1_000_000_000n,
			gasPrice: transaction.gasPrice || await this.getGasPrice(),
		}
		return await this.call(offChainTransaction)
	}

	private readonly executeTransaction = async (transaction: Partial<IUnsignedTransaction> & { to: bigint | null }): Promise<TransactionReceipt> => {
		const transactionHash = await this.submitTransaction(transaction)
		let receipt = await this.getTransactionReceipt(transactionHash)
		// TODO: find out if Parity, Geth or MM return a receipt with a null block anymore (docs suggest no)
		while (receipt === null || receipt.blockNumber === null) {
			await sleep(1000)
			receipt = await this.getTransactionReceipt(transactionHash)
		}
		if (!receipt.status) throw new Error(`Transaction mined, but failed.`)
		if (!receipt.contractAddress && !transaction.to) throw new Error(`Contract deployment failed.  Contract address was null.`)
		return receipt
	}

	private readonly submitTransaction = async (transaction: Partial<IUnsignedTransaction> & { to: bigint | null }): Promise<bigint> => {
		const { encodedTransaction } = await this.signTransaction(transaction)
		return await this.sendRawTransaction(encodedTransaction)
	}

	private readonly makeRequest = <
		// https://github.com/microsoft/TypeScript/issues/32976 TRequestConstructor should be constrained to constructors that take a string|number|null first parameter
		TRequestConstructor extends new (...args: any[]) => { wireEncode: () => IJsonRpcRequest<JsonRpcMethod, any[]> },
		TResponseConstructor extends new (rawResponse: IJsonRpcSuccess<any>) => { result: any },
		TRequest extends InstanceType<TRequestConstructor>,
		TResponse extends InstanceType<TResponseConstructor>,
		TResponseResult extends ResultType<TResponse>,
	>(Request: TRequestConstructor, Response: TResponseConstructor) => async (...args: DropFirst<ConstructorParameters<TRequestConstructor>>): Promise<TResponseResult> => {
		const request = new Request(0, ...args) as TRequest
		const rawRequest = request.wireEncode() as RawRequestType<TRequest>
		const rawResponse = await this.remoteProcedureCall(rawRequest) as PickFirst<ConstructorParameters<TResponseConstructor>>
		const response = new Response(rawResponse) as TResponse
		return response.result as TResponseResult
	}

	public readonly call = this.makeRequest(Rpc.Eth.Call.Request, Rpc.Eth.Call.Response)
	// see constructor
	public readonly coinbase: () => Promise<bigint|null>
	public readonly estimateGas = this.makeRequest(Rpc.Eth.EstimateGas.Request, Rpc.Eth.EstimateGas.Response)
	// see constructor
	public readonly getAccounts: () => Promise<Array<bigint>>
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
	public readonly getProof = this.makeRequest(Rpc.Eth.GetProof.Request, Rpc.Eth.GetProof.Response)
	public readonly getStorageAt = this.makeRequest(Rpc.Eth.GetStorageAt.Request, Rpc.Eth.GetStorageAt.Response)
	public readonly getTransactionByBlockHashAndIndex = this.makeRequest(Rpc.Eth.GetTransactionByBlockHashAndIndex.Request, Rpc.Eth.GetTransactionByBlockHashAndIndex.Response)
	public readonly getTransactionByBlockNumberAndIndex = this.makeRequest(Rpc.Eth.GetTransactionByBlockNumberAndIndex.Request, Rpc.Eth.GetTransactionByBlockNumberAndIndex.Response)
	public readonly getTransactionByHash = this.makeRequest(Rpc.Eth.GetTransactionByHash.Request, Rpc.Eth.GetTransactionByHash.Response)
	public readonly getTransactionCount = this.makeRequest(Rpc.Eth.GetTransactionCount.Request, Rpc.Eth.GetTransactionCount.Response)
	// workaround for Parity returning partial transaction receipts before mining
	// public readonly getTransactionReceipt = this.makeRequest(Rpc.Eth.GetTransactionReceipt.Request, Rpc.Eth.GetTransactionReceipt.Response)
	public readonly getTransactionReceipt = async (transactionHash: bigint): Promise<TransactionReceipt | null> => {
		const request = new Rpc.Eth.GetTransactionReceipt.Request(0, transactionHash)
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
	public readonly sendTransaction = this.submitTransaction
	public readonly signTransaction = async (transaction: Partial<IUnsignedTransaction> & { to: bigint | null }): Promise<Rpc.Eth.SignTransaction.Response['result']> => {
		const gasEstimatingTransaction = {
			from: transaction.from !== undefined ? transaction.from : await this.coinbase().catch(() => null) || 0n,
			to: transaction.to,
			value: transaction.value || 0n,
			data: transaction.data || new Bytes(),
			gasLimit: transaction.gasLimit || 1_000_000_000n,
			gasPrice: transaction.gasPrice || await this.getGasPrice(),
		}
		const unsignedTransaction = {
			...gasEstimatingTransaction,
			gasLimit: transaction.gasLimit || await this.gasLimitProvider(gasEstimatingTransaction, this.estimateGas),
			nonce: transaction.nonce || await this.getTransactionCount(gasEstimatingTransaction.from, 'pending'),
			chainId: await this.chainId,
		}
		if (this.signatureProvider === undefined) {
			return  await this.makeRequest(Rpc.Eth.SignTransaction.Request, Rpc.Eth.SignTransaction.Response)(unsignedTransaction)
		} else {
			const rlpEncodedUnsignedTransaction = this.rlpEncodeTransaction(unsignedTransaction)
			const signature = await this.signatureProvider(rlpEncodedUnsignedTransaction)
			const v = (signature.yParity === 'even' ? 0n : 1n) + 35n + 2n * unsignedTransaction.chainId
			const decodedTransaction = {...unsignedTransaction, r: signature.r, s: signature.s, v }
			const encodedTransaction = this.rlpEncodeTransaction(decodedTransaction)
			return { decodedTransaction, encodedTransaction }
		}
	}
	public readonly sign = async (signerAddress: bigint, data: Uint8Array) => {
		if (this.signatureProvider === undefined) return this.makeRequest(Rpc.Eth.Sign.Request, Rpc.Eth.Sign.Response)(signerAddress, data)
		if (await this.coinbase() !== signerAddress) throw new Error(`Cannot sign messages for address 0x${signerAddress.toString(16).padStart(40, '0')}`)
		const messageToSign = this.mutateMessageForSigning(data)
		const signature = await this.signatureProvider(messageToSign)
		return this.encodeSignature(signature)
	}
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
		if (isJsonRpcError(responseBody)) throw new ErrorWithData(this.extractErrorMessage(responseBody.error), { request, code: responseBody.error.code, data: responseBody.error.data })
		return responseBody
	}

	private readonly rlpEncodeTransaction = (transaction: IUnsignedTransaction | ISignedTransaction): Bytes => {
		const toEncode = [
			stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.nonce, 256)),
			stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.gasPrice, 256)),
			stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.gasLimit, 256)),
			stripLeadingZeros(transaction.to !== null ? Bytes.fromUnsignedInteger(transaction.to, 256) : new Uint8Array(0)),
			stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.value, 256)),
			new Uint8Array(transaction.data),
		]
		if (!this.isSignedTransaction(transaction)) {
			toEncode.push(stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.chainId, 256)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
			toEncode.push(stripLeadingZeros(new Uint8Array(0)))
		} else {
			toEncode.push(stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.v, 256)))
			toEncode.push(stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.r, 256)))
			toEncode.push(stripLeadingZeros(Bytes.fromUnsignedInteger(transaction.s, 256)))
		}
		return Bytes.fromByteArray(rlpEncode(toEncode))
	}

	private readonly isSignedTransaction = (transaction: IUnsignedTransaction | ISignedTransaction): transaction is ISignedTransaction => (transaction as any).r !== undefined

	private readonly mutateMessageForSigning = (message: string | Uint8Array): Bytes => {
		message = (typeof message === 'string') ? new TextEncoder().encode(message) : message
		const messagePrefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length.toString(10)}`)
		return Bytes.fromByteArray([...messagePrefix, ...message])
	}

	private readonly encodeSignature = (signature: SignatureLike): Bytes => {
		const v = (signature.yParity === 'even' ? 0n : 1n) + 27n
		const rSegment = Bytes.fromUnsignedInteger(signature.r, 256)
		const sSegment = Bytes.fromUnsignedInteger(signature.s, 256)
		const vSegment = Bytes.fromUnsignedInteger(v, 8)
		return Bytes.fromByteArray([...rSegment, ...sSegment, ...vSegment])
	}

	private readonly extractErrorMessage = (error: IJsonRpcError['error']): string => {
		if (typeof error.data !== 'string') return error.message
		// handle contract revert errors from Parity
		if (error.data.startsWith('Reverted 0x08c379a0')) {
			const offset = Number.parseInt(error.data.substr('Reverted 0x08c379a0'.length, 64), 16) * 2
			const length = Number.parseInt(error.data.substr('Reverted 0x08c379a0'.length + offset, 64), 16) * 2
			const message = new TextDecoder().decode(Bytes.fromHexString(error.data.substr(19 + offset + 64, length)))
			return `Contract Error: ${message}`
		}
		// handle contract revert errors from Nethermind
		if (error.data.startsWith('revert: ')) {
			const message = error.data.substr('revert: '.length)
			return `Contract Error: ${message}`
		}
		return error.message
	}
}

type DropFirst<T extends any[]> = ((...t: T) => void) extends ((x: any, ...u: infer U) => void) ? U : never
type PickFirst<T extends any[]> = ((...t: T) => void) extends ((x: infer U, ...u: any[]) => void) ? U : never
type ResultType<T extends { result: unknown }> = T extends { result: infer R } ? R : never
type RawRequestType<T extends { wireEncode: () => IJsonRpcRequest<JsonRpcMethod, unknown[]> }> = T extends { wireEncode: () => infer R } ? R : never
type PartiallyRequired<T, K extends keyof T> = { [Key in Exclude<keyof T, K>]?: T[Key] } & { [Key in K]-?: T[Key] }
// https://github.com/microsoft/TypeScript/issues/31535
declare class TextEncoder { encode(input?: string): Uint8Array }
declare class TextDecoder { decode(input?: Uint8Array): string }
