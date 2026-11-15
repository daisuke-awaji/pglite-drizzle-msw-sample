import { describe, expect, test } from 'vitest'
import { ConfigError, parseListen, readConfig } from './config'

describe('AWS_LAMBDA_HTTP_ENDPOINT', () => {
  test('host:port を読む。ないときはローカルの 127.0.0.1:3000', () => {
    expect(parseListen('127.0.0.1:8080')).toEqual({ hostname: '127.0.0.1', port: 8080 })
    expect(parseListen('0.0.0.0:9000')).toEqual({ hostname: '0.0.0.0', port: 9000 })
    expect(parseListen(undefined)).toEqual({ hostname: '127.0.0.1', port: 3000 })
  })

  test('IPv6 は角かっこを外す（ポートを決め打ちしない）', () => {
    expect(parseListen('[::1]:7000')).toEqual({ hostname: '::1', port: 7000 })
  })

  test.each(['8080', 'localhost', 'host:0', 'host:70000', ':8080'])('形が違えば起動時に止める: %s', (v) => {
    expect(() => parseListen(v)).toThrow(ConfigError)
  })
})

describe('設定', () => {
  const aws = { APP_ENV: 'stg', DB_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-1:111122223333:secret:app', COGNITO_USER_POOL_ID: 'ap-northeast-1_x', COGNITO_CLIENT_ID: 'c' }

  test('AWS では秘密情報の ARN を読み、TLS は証明書まで確かめる', () => {
    const c = readConfig(aws)
    expect(c.db).toMatchObject({ kind: 'secret', ssl: 'verify-full', poolMax: 10, connectTimeoutMs: 20_000 })
    expect(c.auth).toEqual({ mode: 'cognito', userPoolId: 'ap-northeast-1_x', clientId: 'c', adminGroup: 'admin' })
  })

  test('ローカルは接続文字列と認証なし', () => {
    const c = readConfig({ DATABASE_URL: 'postgres://localhost/app' })
    expect(c).toMatchObject({ appEnv: 'local', db: { kind: 'url', ssl: 'disable' }, auth: { mode: 'none' }, buildSha: 'local' })
  })

  test('prod では認証なしにできない', () => {
    expect(() => readConfig({ ...aws, APP_ENV: 'prod', AUTH_MODE: 'none' })).toThrow(/prod では AUTH_MODE=none/)
  })

  test('AWS では DB の暗号化を外せない', () => {
    expect(() => readConfig({ ...aws, DB_SSL: 'disable' })).toThrow(/DB_SSL=disable/)
  })

  test('cognito には User Pool と Client が要る', () => {
    expect(() => readConfig({ ...aws, COGNITO_CLIENT_ID: '' })).toThrow(/COGNITO_USER_POOL_ID と COGNITO_CLIENT_ID/)
  })

  test('DB の設定がなければ止める。数値は範囲を確かめる', () => {
    expect(() => readConfig({})).toThrow(/DATABASE_URL/)
    expect(() => readConfig({ DATABASE_URL: 'postgres://x', DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/)
    expect(() => readConfig({ DATABASE_URL: 'postgres://x', DB_POOL_MAX: 'ten' })).toThrow(/DB_POOL_MAX/)
    expect(readConfig({ DATABASE_URL: 'postgres://x', DB_POOL_MAX: '5' }).db.poolMax).toBe(5)
  })
})
