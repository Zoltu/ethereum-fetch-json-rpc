export const sleep = async (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

declare function setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): unknown;
