import { Annotations, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { ApiStack } from './api.ts'
import { nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'
import type { DataStack } from './data.ts'
import { grantSecretRead } from './grants.ts'
import type { NetworkStack } from './network.ts'

export type MigrateStackProps = StackProps & {
  config: AppConfig
  stage: EnvConfig
  network: NetworkStack
  data: DataStack
  api: ApiStack
  /** S3 の migrate/<buildSha>.zip を使う。デプロイの手順が -c buildSha=<SHA> で渡す */
  buildSha: string
}

/**
 * マイグレーションの実行役（migrate）と、DB の利用者を作る関数（db-bootstrap）。
 * API より先に更新するので、API とは別のスタックにする（docs/production.md「いつものリリース」の 3）。
 * どちらも VPC の app サブネットに置き、それぞれの秘密情報だけを読める
 */
export class MigrateStack extends Stack {
  readonly migrateFunction: lambda.Function
  readonly bootstrapFunction: lambda.Function

  constructor(scope: Construct, id: string, props: MigrateStackProps) {
    super(scope, id, props)
    const { config, stage: env, network, data, api, buildSha } = props
    // キーはコミット SHA で、同じキーに上書きしない（scripts/deploy の upload が If-None-Match で防ぐ）。
    // そのため objectVersion はいらない（SHA が変われば関数が更新される）
    const code = lambda.Code.fromBucketV2(api.codeBucket, `migrate/${buildSha}.zip`)

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/${nameOf(config, env, name)}`,
        retention: env.logRetentionDays as logs.RetentionDays,
        encryptionKey: data.key,
        removalPolicy: env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      })

    const common = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code,
      vpc: network.vpc,
      vpcSubnets: network.appSubnets,
      securityGroups: [network.jobsSg],
      allowPublicSubnet: false,
      memorySize: 1024,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
    }

    this.migrateFunction = new lambda.Function(this, 'Migrate', {
      ...common,
      functionName: nameOf(config, env, 'migrate'),
      description: `Database migrations (${buildSha})`,
      handler: 'index.handler',
      // 1 文は statement_timeout（10 分）で止める。15 分を超えるものは Fargate の RunTask で流す（docs/production.md「Fargate を使うとき」）
      timeout: Duration.minutes(15),
      // 同時に 1 つしか動かさない（実行役の advisory lock と二重に防ぐ）
      reservedConcurrentExecutions: 1,
      // 失敗しても自動でやり直さない（デプロイの手順が結果を見て決める）
      retryAttempts: 0,
      logGroup: logGroup('migrate'),
      environment: {
        MIGRATOR_SECRET_ARN: data.migratorSecret.secretArn,
        // ローテーションで複製された利用者でも、表の持ち主を migrator にそろえる
        MIGRATOR_ROLE: 'migrator',
        DB_SSL: 'verify-full',
        NODE_OPTIONS: '--enable-source-maps',
      },
    })
    grantSecretRead(this.migrateFunction, [data.migratorSecret], data.key)

    this.bootstrapFunction = new lambda.Function(this, 'DbBootstrap', {
      ...common,
      functionName: nameOf(config, env, 'db-bootstrap'),
      description: 'Create database users (run once per environment)',
      handler: 'bootstrap.handler',
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      logGroup: logGroup('db-bootstrap'),
      environment: {
        ADMIN_SECRET_ARN: data.adminSecret.secretArn,
        APP_SECRET_ARN: data.appSecret.secretArn,
        MIGRATOR_SECRET_ARN: data.migratorSecret.secretArn,
        READONLY_SECRET_ARN: data.readonlySecret.secretArn,
        DB_NAME: 'app',
        DB_SSL: 'verify-full',
        NODE_OPTIONS: '--enable-source-maps',
      },
    })
    // 管理者の秘密情報を読めるのは、この関数とローテーションの関数だけ
    // RDS が管理する管理者の秘密情報は、RDS が既定のキー（aws/secretsmanager）で暗号化する
    grantSecretRead(this.bootstrapFunction, [data.adminSecret], undefined)
    grantSecretRead(this.bootstrapFunction, [data.appSecret, data.migratorSecret, data.readonlySecret], data.key)

    Annotations.of(api.codeBucket).acknowledgeWarning('@aws-cdk/aws-lambda:codeFromBucketObjectVersionNotSpecified', 'キーにコミット SHA を入れ、上書きしない')

    new ssm.StringParameter(this, 'MigrateFunctionParam', {
      parameterName: paramOf(config, env, 'migrate/function-name'),
      stringValue: this.migrateFunction.functionName,
    })
    new ssm.StringParameter(this, 'BootstrapFunctionParam', {
      parameterName: paramOf(config, env, 'migrate/bootstrap-function-name'),
      stringValue: this.bootstrapFunction.functionName,
    })
  }
}
