import { rename, unlink, writeFile } from 'node:fs/promises'

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖。
 *
 * 两个细节缺一不可：
 * 1. 临时文件名带进程内自增序号。以前写成 `${path}.${pid}.tmp`，同一个进程里
 *    并发两次写会撞同一个临时名，rename 时互相踩，报 EPERM / 丢数据。
 * 2. Windows 上目标文件被短暂占用时 rename 会失败（EPERM/EBUSY/EACCES），
 *    短退避重试几次比直接抛错现实得多。
 */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
let seq = 0

export async function renameWithRetry(from, to, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const retryable = RETRY_CODES.has(error?.code) && i < attempts - 1
      if (!retryable) {
        await unlink(from).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * (i + 1)))
    }
  }
}

export async function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`
  await writeFile(tmp, text, 'utf8')
  await renameWithRetry(tmp, file)
}

export async function writeJsonAtomic(file, value, space = 0) {
  await writeFileAtomic(file, JSON.stringify(value, null, space))
}
