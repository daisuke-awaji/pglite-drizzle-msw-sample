import { afterEach, describe, expect, test, vi } from 'vitest'

const recordError = vi.fn()
const constructed = vi.fn()
vi.mock('aws-rum-web', () => ({
  AwsRum: class {
    constructor(...args: unknown[]) {
      constructed(...args)
    }
    recordError = recordError
  },
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  recordError.mockReset()
  constructed.mockReset()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('CloudWatch RUM', () => {
  test('アプリモニターの設定がなければ読み込まない（モックのビルドとローカル）', async () => {
    const { sendToRum } = await import('./rum')
    sendToRum(new Error('x'))
    await flush()
    expect(constructed).not.toHaveBeenCalled()
  })

  test('設定があれば、最初のエラーで 1 回だけ作り、署名なし・クッキーなしで送る', async () => {
    vi.stubEnv('VITE_RUM_APP_MONITOR_ID', 'monitor-1')
    vi.stubEnv('VITE_APP_VERSION', 'abc123')
    const { sendToRum } = await import('./rum')
    sendToRum(new Error('1'))
    sendToRum(new Error('2'))
    await flush()
    await flush()
    expect(constructed).toHaveBeenCalledTimes(1)
    expect(constructed).toHaveBeenCalledWith('monitor-1', 'abc123', 'ap-northeast-1', expect.objectContaining({ signing: false, allowCookies: false, telemetries: ['errors'], pageIdFormat: 'PATH' }))
    expect(recordError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['1', '2'])
  })
})
