import { assert, use as chaiUse } from "chai"
import chaiBytes from 'chai-bytes'
chaiUse(chaiBytes)
import { stripLeadingZeros } from './utils'

declare global { const console: { log: (message: string) => void; error: (message: string) => void } }

try {
	assert.equalBytes(stripLeadingZeros(new Uint8Array([])), [])
	assert.equalBytes(stripLeadingZeros(new Uint8Array([0,0,0])), [])
	assert.equalBytes(stripLeadingZeros(new Uint8Array([1,2,3])), [1,2,3])
	assert.equalBytes(stripLeadingZeros(new Uint8Array([1,2,3,0,0])), [1,2,3,0,0])
	assert.equalBytes(stripLeadingZeros(new Uint8Array([0,0,1,2,3])), [1,2,3])
	assert.equalBytes(stripLeadingZeros(new Uint8Array([0,1,2,3,0])), [1,2,3,0])
	console.log(`\x1b[32mTests passed.\x1b[0m`)
} catch (error) {
	console.error(error)
	console.log(`\x1b[31mOne or more tests failed.\x1b[0m`)
}
