// 再現できる zip（同じ中身なら同じバイト列）。Lambda に渡すコードの zip を作るのに使う（scripts/build-server.mjs）。
// - 日時は固定（1980-01-01）、並びはパスの順、権限は 0644 にそろえる（ビルドした場所・時刻で変わらない）
// - 依存を足さないために Node の zlib（deflateRaw・crc32）だけで書く
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib'

const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01

/**
 * @param {{ path: string, data: Buffer }[]} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const seen = new Set()
  const locals = []
  const centrals = []
  let offset = 0
  for (const { path, data } of sorted) {
    if (seen.has(path)) throw new Error(`zip に同じパスが 2 つあります: ${path}`)
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) throw new Error(`zip のパスが正しくありません: ${path}`)
    seen.add(path)
    const name = Buffer.from(path, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 のファイル名
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // 通常のファイル、0644
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * 中身を読む（テストと、ビルドのあとの確認に使う）。CRC も確かめる
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>}
 */
export function readZip(zip) {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endAt < 0) throw new Error('zip の終わりが見つかりません')
  const count = zip.readUInt16LE(endAt + 10)
  let p = zip.readUInt32LE(endAt + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip の目次が壊れています')
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const size = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localAt = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const localNameLen = zip.readUInt16LE(localAt + 26)
    const localExtraLen = zip.readUInt16LE(localAt + 28)
    const start = localAt + 30 + localNameLen + localExtraLen
    const raw = zip.subarray(start, start + size)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (crc32(data) !== crc) throw new Error(`CRC が合いません: ${name}`)
    out.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
