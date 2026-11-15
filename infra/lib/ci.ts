import { Duration, Stack, type StackProps } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import type { Construct } from 'constructs'
import { nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'

export type CiStackProps = StackProps & {
  config: AppConfig
  stage: EnvConfig
  functionName: string
  codeBucketArn: string
  siteBucketArn: string
  distributionArn: string
  migrateFunctionArn: string
  bootstrapFunctionArn: string
  executionRoleArn: string
  connectorArn?: string
}

/**
 * GitHub Actions がデプロイに使う IAM ロール（OIDC。長期のアクセスキーを持たない）。
 * 信頼ポリシーは、このリポジトリのこの環境（GitHub Environments）のジョブだけ。
 * 権限は「CDK の bootstrap のロールを引き受ける」「デプロイの手順が触るものだけ」にする。
 * live の呼び出しは CloudFront だけに許し、このロールは next（確認用）だけを呼べる
 */
export class CiStack extends Stack {
  readonly role: iam.Role

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props)
    const { config, stage: env } = props
    const host = 'token.actions.githubusercontent.com'

    const provider = config.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', config.githubOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: `https://${host}`, clientIds: ['sts.amazonaws.com'] })

    this.role = new iam.Role(this, 'DeployRole', {
      roleName: nameOf(config, env, 'github-deploy'),
      description: `GitHub Actions deploy (${config.githubRepository}, environment ${env.githubEnvironment})`,
      maxSessionDuration: Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${host}:aud`]: 'sts.amazonaws.com',
          [`${host}:sub`]: `repo:${config.githubRepository}:environment:${env.githubEnvironment}`,
        },
      }),
    })

    // Web Function の ARN は web-function/<名前>。endpoint は <関数の ARN>/endpoint/<名前>
    const fn = `arn:${this.partition}:lambda:${this.region}:${this.account}:web-function/${props.functionName}`
    const statements = [
      // cdk deploy（Migrate・Api など）。CloudFormation の変更は CDK の bootstrap のロールが行う
      new iam.PolicyStatement({
        sid: 'CdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
      new iam.PolicyStatement({ sid: 'ReadParams', actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${paramOf(config, env, '*')}`] }),
      new iam.PolicyStatement({
        sid: 'WriteEndpointParams',
        actions: ['ssm:PutParameter'],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${paramOf(config, env, 'api/*-domain')}`],
      }),
      // コード: 置く・確かめる（上書きはスクリプトが If-None-Match で防ぐ）。消さない
      new iam.PolicyStatement({ sid: 'CodeUpload', actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'], resources: [`${props.codeBucketArn}/api/*`, `${props.codeBucketArn}/migrate/*`] }),
      new iam.PolicyStatement({ sid: 'CodeList', actions: ['s3:ListBucket'], resources: [props.codeBucketArn] }),
      // 画面: 置く（古い JS・CSS は消さない）
      new iam.PolicyStatement({ sid: 'SiteUpload', actions: ['s3:PutObject', 's3:GetObject'], resources: [`${props.siteBucketArn}/*`] }),
      new iam.PolicyStatement({ sid: 'SiteList', actions: ['s3:ListBucket'], resources: [props.siteBucketArn] }),
      new iam.PolicyStatement({ sid: 'Invalidate', actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: [props.distributionArn] }),
      // マイグレーション（同期で 1 回）
      new iam.PolicyStatement({ sid: 'InvokeMigrate', actions: ['lambda:InvokeFunction'], resources: [props.migrateFunctionArn, props.bootstrapFunctionArn] }),
      // revision と endpoint（作る・確かめる・重みを変える）。endpoint は IamAuth しか作れない
      new iam.PolicyStatement({
        sid: 'WebFunctionRelease',
        actions: [
          'lambda:CreateWebFunctionRevision',
          'lambda:GetWebFunction',
          'lambda:GetWebFunctionRevision',
          'lambda:ListWebFunctionRevisions',
          'lambda:GetWebFunctionEndpoint',
          'lambda:ListWebFunctionEndpoints',
        ],
        resources: [fn, `${fn}/*`],
      }),
      // endpoint を作るのは関数への操作、重みを変えるのは endpoint への操作。どちらも IamAuth しか指定できない
      new iam.PolicyStatement({
        sid: 'CreateEndpoints',
        actions: ['lambda:CreateWebFunctionEndpoint'],
        resources: [fn],
        conditions: { StringEquals: { 'lambda:Request/WebFunctionAuthType': 'IamAuth' } },
      }),
      new iam.PolicyStatement({
        sid: 'UpdateEndpoints',
        actions: ['lambda:UpdateWebFunctionEndpoint'],
        resources: [`${fn}/endpoint/live`, `${fn}/endpoint/next`],
        // 重みだけを変えるリクエストには authType がないので IfExists（変えようとしたら IamAuth だけ）
        conditions: { StringEqualsIfExists: { 'lambda:Request/WebFunctionAuthType': 'IamAuth' } },
      }),
      // revision は実行ロールと Network Connector を指して作る
      new iam.PolicyStatement({ sid: 'PassExecutionRole', actions: ['iam:PassRole'], resources: [props.executionRoleArn], conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } }),
      new iam.PolicyStatement({
        sid: 'PassConnector',
        actions: ['lambda:PassNetworkConnector'],
        resources: [`arn:${this.partition}:lambda:${this.region}:${this.account}:network-connector:*`],
      }),
      // スモークテスト: next だけ（live は CloudFront からだけ）
      new iam.PolicyStatement({ sid: 'SmokeNext', actions: ['lambda:InvokeWebFunctionEndpoint'], resources: [`${fn}/endpoint/next`] }),
      // カナリアの間、5xx のアラームを見る
      new iam.PolicyStatement({ sid: 'WatchAlarms', actions: ['cloudwatch:DescribeAlarms'], resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${nameOf(config, env, '*')}`] }),
    ]
    for (const s of statements) this.role.addToPolicy(s)
  }
}
