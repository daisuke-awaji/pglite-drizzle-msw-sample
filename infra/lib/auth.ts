import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'

export type AuthStackProps = StackProps & { config: AppConfig; stage: EnvConfig; siteDomain: string }

/** 管理者のグループ。メンバーの登録・変更・削除と、タグの削除ができる（server/auth.ts） */
export const ADMIN_GROUP = 'admin'

/**
 * ログイン（Phase 4）。画面は Cognito のマネージドログインに移り、認可コード + PKCE でトークンを受け取る（src/auth）。
 * API は ID トークンを検証し、メールアドレスでメンバーを見分ける（server/auth.ts）。
 * - 自分では登録できない（管理者が招待する）。prod は MFA を必須にする
 * - 値（User Pool の ID・クライアント ID・ドメイン）は SSM パラメーターに書き、デプロイの手順が API の revision と画面のビルドに渡す
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool
  readonly client: cognito.UserPoolClient

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props)
    const { config, stage: env, siteDomain } = props

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: nameOf(config, env, 'users'),
      selfSignUpEnabled: env.auth.selfSignUp,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true, tempPasswordValidity: Duration.days(3) },
      mfa: env.auth.mfaRequired ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // マネージドログイン（新しい画面）は Essentials 以上
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: env.deletionProtection,
      removalPolicy: env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    })
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', { userPoolId: this.userPool.userPoolId, groupName: ADMIN_GROUP, description: 'Manage members and tags' })

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: env.auth.domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    })

    const origin = `https://${siteDomain}`
    const callbackUrls = [`${origin}/auth/callback`, ...(env.name === 'dev' ? ['http://localhost:5173/auth/callback'] : [])]
    this.client = this.userPool.addClient('WebClient', {
      userPoolClientName: nameOf(config, env, 'web'),
      // ブラウザで動く公開クライアント。秘密を持たず、PKCE で守る
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: [`${origin}/`, ...(env.name === 'dev' ? ['http://localhost:5173/'] : [])],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      // 画面はリフレッシュトークンをタブの sessionStorage に置く。業務時間の 1 日で切れるようにする
      refreshTokenValidity: Duration.hours(12),
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true, emailVerified: true, fullname: true }),
    })
    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    })

    const param = (pid: string, name: string, value: string) => new ssm.StringParameter(this, pid, { parameterName: paramOf(config, env, name), stringValue: value })
    param('UserPoolIdParam', 'auth/user-pool-id', this.userPool.userPoolId)
    param('ClientIdParam', 'auth/client-id', this.client.userPoolClientId)
    param('DomainParam', 'auth/domain', `${domain.domainName}.auth.${this.region}.amazoncognito.com`)
    param('AdminGroupParam', 'auth/admin-group', ADMIN_GROUP)
  }
}
