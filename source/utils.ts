export function stripLeadingZeros(byteArray: Uint8Array): Uint8Array {
	let i = 0
	for (; i < byteArray.length; ++i) {
		if (byteArray[i] !== 0) break
	}
	const result = new Uint8Array(byteArray.length - i)
	for (let j = 0; j < result.length; ++j) {
		result[j] = byteArray[i + j]
	}
	return result
}
