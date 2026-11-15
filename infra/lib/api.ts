import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { bucketOf, nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'
import type { DataStack } from './data.ts'
import { grantSecretRead } from './grants.ts'
import type { NetworkStack } from './network.ts'

export type ApiStackProps = StackProps & { config: AppConfig; stage: EnvConfig; network: NetworkStack; data: DataStack }

/**
 * Web Function（API）の入れ物。revision と endpoint はデプロイの手順（infra/scripts/deploy）で作って動かし、CloudFormation では持たない。
 * - CloudFormation で持つと、デプロイのたびに前の revision が消え（戻すのに作り直しが要る）、手で戻した重みを次の deploy が上書きする
 * - revision の設定（実行ロール・Network Connector のバージョン付き ARN・環境変数・ログ）は SSM パラメーターに書き、スクリプトが読む
 * docs/production.md「設計の判断」「初回の構築」の 6
 */
export class ApiStack extends Stack {
  readonly functionName: string
  readonly functionArn: string
  readonly codeBucket: s3.Bucket
  readonly logGroup: logs.LogGroup
  readonly executionRole: iam.Role

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props)
    const { config, stage: env, network, data } = props
    const retain = env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    this.functionName = nameOf(config, env, 'api')

    // コードの zip（api/<SHA>.zip・migrate/<SHA>.zip）。同じキーに上書きしない（スクリプトが If-None-Match で防ぐ）
    this.codeBucket = new s3.Bucket(this, 'CodeBucket', {
      bucketName: bucketOf(config, env, 'code'),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: retain,
      autoDeleteObjects: !env.deletionProtection,
      // 戻し先は直近の数回で足りる。古い版の zip だけを消す（最新の版は消さない）
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    })

    // ログは Lambda が標準出力から集める。.local は各リージョンの一時置き場（HomeRegion だけなので東京のみ）
    const logGroupName = `/aws/lambda/web/${this.functionName}`
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: env.logRetentionDays as logs.RetentionDays,
      encryptionKey: data.key,
      removalPolicy: retain,
    })
    const localLogGroup = new logs.LogGroup(this, 'LocalLogGroup', {
      logGroupName: `${logGroupName}.local`,
      retention: logs.RetentionDays.THREE_DAYS,
      encryptionKey: data.key,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    data.key.grantEncryptDecrypt(new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`))

    const webFunction = new lambda.CfnWebFunction(this, 'WebFunction', { functionName: this.functionName })
    this.functionArn = webFunction.attrFunctionArn

    // アプリが使う権限: app の秘密情報を読む、ログを書く。それ以外は持たない
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: nameOf(config, env, 'api-execution'),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Lambda Web Function (API) execution role',
    })
    grantSecretRead(this.executionRole, [data.appSecret], data.key)
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${this.logGroup.logGroupArn}:*`, `${localLogGroup.logGroupArn}:*`],
      }),
    )

    // Network Connector: Web Function の外向きの通信を VPC の app サブネットに出す
    const operatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      roleName: nameOf(config, env, 'connector-operator'),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
      description: 'Lambda manages the network interfaces of the Network Connector',
    })
    const subnetArns = network.vpc.selectSubnets(network.appSubnets).subnetIds.map((sid) => `arn:${this.partition}:ec2:${this.region}:${this.account}:subnet/${sid}`)
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CreateENI',
        actions: ['ec2:CreateNetworkInterface'],
        resources: [
          `arn:${this.partition}:ec2:${this.region}:${this.account}:network-interface/*`,
          ...subnetArns,
          `arn:${this.partition}:ec2:${this.region}:${this.account}:security-group/${network.connectorSg.securityGroupId}`,
        ],
      }),
    )
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TagENI',
        actions: ['ec2:CreateTags'],
        resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:network-interface/*`],
        conditions: { StringEquals: { 'ec2:ManagedResourceOperator': 'network-connectors.lambda.amazonaws.com' } },
      }),
    )
    const connector = new lambda.CfnNetworkConnector(this, 'NetworkConnector', {
      name: nameOf(config, env, 'api-egress'),
      operatorRole: operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          subnetIds: network.vpc.selectSubnets(network.appSubnets).subnetIds,
          securityGroupIds: [network.connectorSg.securityGroupId],
          networkProtocol: 'IPv4',
          associatedComputeResourceTypes: ['WebFunction'],
        },
      },
    })
    connector.node.addDependency(operatorRole)

    // revision の設定。新しい revision は前の設定を引き継がないので、スクリプトはいつもこの全体から作る。
    // 認証（Cognito）の値は AuthStack の SSM パラメーターから、ビルドの SHA はスクリプトが足す
    const revisionConfig = {
      executionRoleArn: this.executionRole.roleArn,
      egressNetworkConnectorArn: connector.attrLatestVersionArn,
      timeoutSeconds: env.api.timeoutSeconds,
      maxConcurrencyPerEnvironment: env.api.maxConcurrencyPerEnvironment,
      environmentVariables: {
        APP_ENV: env.name,
        DB_SECRET_ARN: data.appSecret.secretArn,
        DB_POOL_MAX: String(env.api.poolMax),
        DB_SSL: 'verify-full',
        // 自動で一時停止した Aurora は戻るまで 15 秒ほどかかる
        DB_CONNECT_TIMEOUT_MS: env.aurora.minAcu === 0 ? '25000' : '10000',
        NODE_OPTIONS: '--enable-source-maps',
      },
      telemetryConfig: { loggingConfig: { logGroup: logGroupName, applicationLogLevel: 'INFO', systemLogLevel: 'WARN' } },
    }
    const param = (pid: string, name: string, value: string, description: string) =>
      new ssm.StringParameter(this, pid, { parameterName: paramOf(config, env, name), stringValue: value, description })
    param('RevisionConfig', 'api/revision-config', Stack.of(this).toJsonString(revisionConfig), 'Web Function revision serviceConfig (deploy scripts)')
    param('EndpointConfig', 'api/endpoint-config', JSON.stringify({ authType: 'IamAuth', endpointType: 'HomeRegion', maxEnvironments: env.api.maxEnvironments, canary: env.canary }), 'Web Function endpoints (deploy scripts)')
    param('FunctionNameParam', 'api/function-name', this.functionName, 'Web Function name')
    param('CodeBucketParam', 'code-bucket', this.codeBucket.bucketName, 'Bucket for api/<sha>.zip and migrate/<sha>.zip')
    param('LogGroupParam', 'api/log-group', logGroupName, 'Web Function log group')
  }
}
