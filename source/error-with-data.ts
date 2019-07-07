export class ErrorWithData extends Error {
	constructor(message: string, data: {[key: string]: any}) {
		super(message)
		Object.setPrototypeOf(this, ErrorWithData.prototype)
		for (let key in data) {
			this[key] = data[key]
		}
	}
	[key: string]: unknown
}
