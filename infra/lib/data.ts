import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as backup from 'aws-cdk-lib/aws-backup'
import * as events from 'aws-cdk-lib/aws-events'
import * as kms from 'aws-cdk-lib/aws-kms'
import type * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import { nameOf, type AppConfig, type EnvConfig } from './config.ts'
import type { NetworkStack } from './network.ts'

export type DataStackProps = StackProps & { config: AppConfig; stage: EnvConfig; network: NetworkStack }

/** DB の名前。ブラウザの PGlite と同じスキーマを、マイグレーションで作る */
export const DATABASE_NAME = 'app'

/**
 * Aurora PostgreSQL 18（Serverless v2）と、DB の利用者ごとの秘密情報。
 * - 管理者のパスワードは RDS が Secrets Manager で管理し、ローテーションも任せる（ManageMasterUserPassword）
 * - app / migrator / readonly の秘密情報は CDK が作り、db-bootstrap 関数が利用者を作る（server/bootstrap.ts）
 * - app と migrator は「2 つの利用者を交互に使う」ローテーション（切り替えの瞬間に接続が切れない）
 */
export class DataStack extends Stack {
  readonly key: kms.Key
  readonly cluster: rds.DatabaseCluster
  readonly adminSecret: secretsmanager.ISecret
  readonly appSecret: secretsmanager.Secret
  readonly migratorSecret: secretsmanager.Secret
  readonly readonlySecret: secretsmanager.Secret

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props)
    const { config, stage: env, network } = props
    const retain = env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${nameOf(config, env, 'data')}`,
      description: 'Aurora storage, database secrets and logs',
      enableKeyRotation: true,
      removalPolicy: retain,
    })

    const parameters = new rds.ParameterGroup(this, 'Parameters', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_18_6 }),
      description: `${config.app} ${env.name}`,
      parameters: {
        // 暗号化していない接続を断る（アプリは RDS の CA で証明書とホスト名を確かめる。server/db.ts）
        'rds.force_ssl': '1',
        // ロック待ちとデッドロックをログに残す（docs/production.md「監視とアラーム」）
        log_lock_waits: '1',
        // 5 秒を超える SQL を残す（値は残さない: パラメーター付きの問い合わせは $1 のまま出る）
        log_min_duration_statement: '5000',
        idle_session_timeout: '900000',
      },
    })

    const writer = rds.ClusterInstance.serverlessV2('Writer', { autoMinorVersionUpgrade: true, publiclyAccessible: false })
    const readers = Array.from({ length: env.aurora.readers }, (_, i) =>
      rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, { scaleWithWriter: true, autoMinorVersionUpgrade: true, publiclyAccessible: false }),
    )

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: nameOf(config, env, 'db'),
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_18_6 }),
      parameterGroup: parameters,
      writer,
      readers,
      serverlessV2MinCapacity: env.aurora.minAcu,
      serverlessV2MaxCapacity: env.aurora.maxAcu,
      ...(env.aurora.minAcu === 0 ? { serverlessV2AutoPauseDuration: Duration.minutes(env.aurora.autoPauseMinutes!) } : {}),
      vpc: network.vpc,
      vpcSubnets: network.dbSubnets,
      securityGroups: [network.dbSg],
      defaultDatabaseName: DATABASE_NAME,
      credentials: rds.Credentials.fromUsername('postgres'),
      manageMasterUserPassword: true,
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      deletionProtection: env.deletionProtection,
      removalPolicy: env.deletionProtection ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      backup: { retention: Duration.days(env.aurora.backupRetentionDays), preferredWindow: '17:00-18:00' },
      preferredMaintenanceWindow: 'sun:18:30-sun:19:30',
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: env.logRetentionDays as logs.RetentionDays,
      iamAuthentication: false,
      copyTagsToSnapshot: true,
      monitoringInterval: env.name === 'prod' ? Duration.seconds(60) : undefined,
    })

    // RDS が管理する管理者のパスワード（MasterUserSecret）。読めるのは db-bootstrap 関数とローテーションだけ
    const cfn = this.cluster.node.defaultChild as rds.CfnDBCluster
    this.adminSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'AdminSecret', cfn.attrMasterUserSecretSecretArn)

    const userSecret = (cid: string, username: string) =>
      new secretsmanager.Secret(this, cid, {
        secretName: `${config.app}/${env.name}/db/${username}`,
        description: `PostgreSQL user ${username} (${config.app} ${env.name})`,
        encryptionKey: this.key,
        removalPolicy: retain,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            engine: 'postgres',
            username,
            host: this.cluster.clusterEndpoint.hostname,
            port: this.cluster.clusterEndpoint.port,
            dbname: DATABASE_NAME,
            // 交互に使う方式のローテーションは、管理者の秘密情報を masterarn から読む
            masterarn: cfn.attrMasterUserSecretSecretArn,
          }),
          generateStringKey: 'password',
          // 接続文字列や SQL の中で扱いにくい文字を使わない
          excludeCharacters: ' "\'@/\\:%?#&=`',
          passwordLength: 40,
        },
      })
    this.appSecret = userSecret('AppSecret', 'app')
    this.migratorSecret = userSecret('MigratorSecret', 'migrator')
    this.readonlySecret = userSecret('ReadonlySecret', 'readonly')

    for (const [secret, rid] of [
      [this.appSecret, 'AppRotation'],
      [this.migratorSecret, 'MigratorRotation'],
    ] as const) {
      secret.addRotationSchedule(rid, {
        automaticallyAfter: Duration.days(30),
        hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
          functionName: nameOf(config, env, rid.toLowerCase()),
          masterSecret: this.adminSecret,
          vpc: network.vpc,
          vpcSubnets: network.appSubnets,
          securityGroups: [network.jobsSg],
        }),
      })
    }

    // readonly は調べ物用の 1 人の利用者なので、自分のパスワードを替える方式（接続は調べ物の間だけ）
    this.readonlySecret.addRotationSchedule('ReadonlyRotation', {
      automaticallyAfter: Duration.days(30),
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
        functionName: nameOf(config, env, 'readonlyrotation'),
        vpc: network.vpc,
        vpcSubnets: network.appSubnets,
        securityGroups: [network.jobsSg],
      }),
    })

    if (env.aurora.monthlyBackup) {
      const vault = new backup.BackupVault(this, 'Vault', { backupVaultName: nameOf(config, env, 'vault'), encryptionKey: this.key, removalPolicy: RemovalPolicy.RETAIN })
      const plan = new backup.BackupPlan(this, 'MonthlyPlan', {
        backupPlanName: nameOf(config, env, 'monthly'),
        backupVault: vault,
        backupPlanRules: [
          new backup.BackupPlanRule({
            ruleName: 'monthly-1y',
            scheduleExpression: events.Schedule.cron({ day: '1', hour: '18', minute: '0' }),
            deleteAfter: Duration.days(365),
          }),
        ],
      })
      plan.addSelection('Cluster', { resources: [backup.BackupResource.fromRdsDatabaseCluster(this.cluster)] })
    }
  }

}
