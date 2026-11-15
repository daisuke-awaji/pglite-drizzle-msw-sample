import { Duration, Stack, type StackProps } from 'aws-cdk-lib'
import * as budgets from 'aws-cdk-lib/aws-budgets'
import * as chatbot from 'aws-cdk-lib/aws-chatbot'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as kms from 'aws-cdk-lib/aws-kms'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as rds from 'aws-cdk-lib/aws-rds'
import * as rum from 'aws-cdk-lib/aws-rum'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { auroraMaxConnections, nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'

export type MonitoringStackProps = StackProps & {
  config: AppConfig
  stage: EnvConfig
  functionName: string
  logGroup: logs.ILogGroup
  migrateFunctionName: string
  cluster: rds.DatabaseCluster
  key: kms.IKey
  siteDomain: string
  /** ほかのリージョンのアラームのトピック（CloudFront。us-east-1）。チャットにも流す */
  extraTopics?: sns.ITopic[]
}

/** アプリのログ（server/log.ts）から作るメトリクスの名前空間 */
export const APP_NAMESPACE = 'App/Api'

/**
 * アラーム・ダッシュボード・画面のエラー（RUM）・費用（docs/production.md「監視とアラーム」の表）。
 * アラームは「利用者が困っているか」と「このままだと困るか」に絞り、SNS からチャット（とメール）へ送る。
 * Web Functions のメトリクスは 0 件の期間に値を出さないものがある（5xx・スロットリング）ので、データがないときは正常として扱う。
 * CloudFront のメトリクスは us-east-1 にだけあるので、そのアラームは EdgeAlarmsStack に置く
 */
export class MonitoringStack extends Stack {
  readonly topic: sns.Topic
  readonly alarms: Record<string, cloudwatch.Alarm> = {}

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props)
    const { config, stage: env, functionName, logGroup, cluster } = props
    const alarmName = (name: string) => nameOf(config, env, name)

    this.topic = new sns.Topic(this, 'Alarms', { topicName: nameOf(config, env, 'alarms'), masterKey: props.key, enforceSSL: true })
    props.key.grantEncryptDecrypt(new iam.ServicePrincipal('cloudwatch.amazonaws.com'))
    if (env.monitoring.alarmEmail) this.topic.addSubscription(new subscriptions.EmailSubscription(env.monitoring.alarmEmail))
    if (env.monitoring.slack) {
      new chatbot.SlackChannelConfiguration(this, 'Slack', {
        slackChannelConfigurationName: nameOf(config, env, 'alarms'),
        slackWorkspaceId: env.monitoring.slack.workspaceId,
        slackChannelId: env.monitoring.slack.channelId,
        notificationTopics: [this.topic, ...(props.extraTopics ?? [])],
        guardrailPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
      })
    }
    const notify = new actions.SnsAction(this.topic)
    const add = (key: string, alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(notify)
      alarm.addOkAction(notify)
      this.alarms[key] = alarm
      return alarm
    }

    // --- Web Function（API） ---
    const web = (metricName: string, statistic: string, dims: Record<string, string> = { FunctionName: functionName, EndpointName: 'live' }, namespace = 'AWS/Lambda/Web') =>
      new cloudwatch.Metric({ namespace, metricName, statistic, dimensionsMap: dims, period: Duration.minutes(5) })
    const executed = web('ExecutedRequests', 'Sum')
    const fiveXx = web('HTTPResponseStatusClass5XX', 'Sum')
    const errorRate = new cloudwatch.MathExpression({
      expression: 'IF(executed > 0, 100 * FILL(m5xx, 0) / executed, 0)',
      usingMetrics: { executed, m5xx: fiveXx },
      label: '5xx (%)',
      period: Duration.minutes(5),
    })
    add('api5xx', errorRate.createAlarm(this, 'Api5xxRate', {
      alarmName: alarmName('api-5xx-rate'),
      alarmDescription: '5xx の割合が 5 分間で 1% を超えた。ログの level=error を見る。直前にデプロイしていれば rollback（docs/production.md「デプロイが失敗した」）',
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))

    // アプリのログから作るメトリクス（Web Functions の標準のメトリクスには応答時間と revision の区別がない）
    const requestFilter = '{ $.message.type = "request" }'
    new logs.MetricFilter(this, 'LatencyFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.literal(requestFilter),
      metricNamespace: APP_NAMESPACE,
      metricName: 'Latency',
      metricValue: '$.message.durationMs',
      unit: cloudwatch.Unit.MILLISECONDS,
    })
    new logs.MetricFilter(this, 'ServerErrorsByBuild', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('{ $.message.type = "request" && $.message.status >= 500 }'),
      metricNamespace: APP_NAMESPACE,
      metricName: 'ServerErrors',
      metricValue: '1',
      // カナリアの間、新しい revision（BUILD_SHA）の 5xx だけを数える
      dimensions: { Build: '$.message.build' },
    })
    new logs.MetricFilter(this, 'InitFailures', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('{ $.type = "platform.initReport" && $.record.status = "failure" }'),
      metricNamespace: APP_NAMESPACE,
      metricName: 'InitFailures',
      metricValue: '1',
    })
    new logs.MetricFilter(this, 'UnexpectedErrors', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('{ $.message.type = "route.error" || $.message.type = "unhandled" || $.message.type = "unhandled-rejection" }'),
      metricNamespace: APP_NAMESPACE,
      metricName: 'UnexpectedErrors',
      metricValue: '1',
    })
    const app = (metricName: string, statistic: string, period = Duration.minutes(5)) => new cloudwatch.Metric({ namespace: APP_NAMESPACE, metricName, statistic, period })

    add('latency', app('Latency', 'p95').createAlarm(this, 'ApiLatencyP95', {
      alarmName: alarmName('api-latency-p95'),
      alarmDescription: '応答時間の p95 が 5 分間 1 秒を超えた。Database Insights で遅い SQL を探す。ACU が上限に張り付いていないか',
      threshold: 1000,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('initFailure', app('InitFailures', 'Sum', Duration.minutes(1)).createAlarm(this, 'ApiInitFailure', {
      alarmName: alarmName('api-init-failure'),
      alarmDescription: '実行環境の起動に失敗した（revision は失敗しても Active になる）。新しい revision なら rollback',
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('unexpected', app('UnexpectedErrors', 'Sum').createAlarm(this, 'ApiUnexpectedErrors', {
      alarmName: alarmName('api-unexpected-errors'),
      alarmDescription: '想定外の例外が 5 分で 10 件を超えた。スタックトレースを見る（利用者には中身を見せていない）',
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))

    const usage = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/Lambda/Web/Usage', metricName, statistic, period: Duration.minutes(1), dimensionsMap: { FunctionName: functionName, EndpointName: 'live', ExecutionRegion: this.region } })
    const throttles = new cloudwatch.MathExpression({
      expression: 'FILL(env, 0) + FILL(vcpu, 0) + FILL(account, 0) + FILL(rate, 0)',
      usingMetrics: {
        env: usage('EndpointActiveEnvironmentThrottles', 'Sum'),
        vcpu: usage('AccountActiveVCPUArm64Throttles', 'Sum'),
        account: usage('AccountRequestThrottles', 'Sum'),
        rate: usage('EndpointRequestThrottles', 'Sum'),
      },
      label: 'throttled (429)',
      period: Duration.minutes(1),
    })
    add('throttles', throttles.createAlarm(this, 'ApiThrottles', {
      alarmName: alarmName('api-throttles'),
      alarmDescription: '429 を返した。maxEnvironments かアカウントの vCPU の上限に届いた。上げるなら DB の接続数と一緒に見直す（infra/lib/config.ts の connectionBudget）',
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('environments', usage('EndpointActiveEnvironments', 'Maximum').with({ period: Duration.minutes(5) }).createAlarm(this, 'ApiEnvironments', {
      alarmName: alarmName('api-environments-high'),
      alarmDescription: `実行環境の数が 15 分間、上限（${env.api.maxEnvironments}）の 80% を超えた。EnvironmentConcurrentRequests と一緒に見る`,
      threshold: Math.max(1, Math.floor(env.api.maxEnvironments * 0.8)),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('memory', web('EnvironmentMaxMemoryUsage', 'Maximum', { FunctionName: functionName }).createAlarm(this, 'ApiMemory', {
      alarmName: alarmName('api-memory-high'),
      alarmDescription: '実行環境のメモリが 1.6 GB を超えた（上限 2 GB）。メモリの漏れか、大きな応答を作っていないか',
      threshold: 1600,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))

    // --- Aurora ---
    add('acu', cluster.metricACUUtilization({ period: Duration.minutes(5), statistic: 'Average' }).createAlarm(this, 'DbAcu', {
      alarmName: alarmName('db-acu-high'),
      alarmDescription: `ACU の使用率が 15 分間 80% を超えた（最大 ${env.aurora.maxAcu} ACU）。最大 ACU を上げる、遅い SQL を直す`,
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('connections', cluster.metricDatabaseConnections({ period: Duration.minutes(5), statistic: 'Maximum' }).createAlarm(this, 'DbConnections', {
      alarmName: alarmName('db-connections-high'),
      alarmDescription: '接続数が max_connections の 80% を超えた。maxEnvironments × poolMax を見直す。閉じられていない接続がないか（application_name ごとに数える）',
      threshold: Math.floor(auroraMaxConnections(env.aurora.maxAcu) * 0.8),
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))
    add('deadlocks', cluster.metric('Deadlocks', { period: Duration.minutes(5), statistic: 'Sum' }).createAlarm(this, 'DbDeadlocks', {
      alarmName: alarmName('db-deadlocks'),
      alarmDescription: 'デッドロックが起きた。ログの SQL を見て、更新の順番をそろえる',
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))

    // --- デプロイ: migrate の失敗 ---
    add('migrate', new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', dimensionsMap: { FunctionName: props.migrateFunctionName }, period: Duration.minutes(5) }).createAlarm(this, 'MigrateErrors', {
      alarmName: alarmName('migrate-failed'),
      alarmDescription: 'マイグレーションが失敗した。パイプラインは止まっている（docs/production.md「マイグレーションが失敗した」）',
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }))

    // --- 画面: JS のエラー（CloudWatch RUM。src/lib/rum.ts） ---
    const monitorName = nameOf(config, env, 'web')
    const appMonitor = new rum.CfnAppMonitor(this, 'Rum', {
      name: monitorName,
      domain: props.siteDomain,
      cwLogEnabled: false,
      appMonitorConfiguration: { sessionSampleRate: 1, telemetries: ['errors'], allowCookies: false, enableXRay: false },
      // 画面は署名なしで送る（Cognito の ID プールを作らない）。このアプリモニターへの PutRumEvents だけを許す
      resourcePolicy: {
        policyDocument: Stack.of(this).toJsonString({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: '*', Action: 'rum:PutRumEvents', Resource: `arn:${this.partition}:rum:${this.region}:${this.account}:appmonitor/${monitorName}` }],
        }),
      },
    })
    const jsErrors = new cloudwatch.Metric({ namespace: 'AWS/RUM', metricName: 'JsErrorCount', statistic: 'Sum', dimensionsMap: { application_name: monitorName }, period: Duration.minutes(5) })
    const jsAlarm = new cloudwatch.AnomalyDetectionAlarm(this, 'WebJsErrors', {
      alarmName: alarmName('web-js-errors'),
      alarmDescription: '画面の JS のエラーがふだんより大きく増えた（RUM）。直前のリリースを疑う',
      metric: jsErrors,
      stdDevs: 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_UPPER_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    add('jsErrors', jsAlarm)
    new ssm.StringParameter(this, 'RumMonitorParam', { parameterName: paramOf(config, env, 'web/rum-app-monitor-id'), stringValue: appMonitor.attrId })

    // --- 費用 ---
    new budgets.CfnBudget(this, 'Budget', {
      budget: { budgetName: nameOf(config, env, 'monthly'), budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: env.monitoring.monthlyBudgetUsd, unit: 'USD' } },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn }],
        },
      ],
    })
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('budgets.amazonaws.com')], actions: ['sns:Publish'], resources: [this.topic.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
    )

    // --- ダッシュボード: 利用者から見た状態 → API → DB ---
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: nameOf(config, env, 'overview'), defaultInterval: Duration.hours(3) })
    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: `# ${config.app} ${env.name}\n利用者から見た状態 → API → DB の順。手順は docs/production.md「手順書」`, width: 24, height: 2 }),
      new cloudwatch.AlarmStatusWidget({ title: 'アラーム', alarms: Object.values(this.alarms), width: 24, height: 3 }),
      new cloudwatch.GraphWidget({ title: 'API: リクエストと 5xx', left: [executed, fiveXx, web('HTTPResponseStatusClass4XX', 'Sum')], right: [errorRate], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'API: 応答時間（ms）', left: [app('Latency', 'p50'), app('Latency', 'p95'), app('Latency', 'p99')], width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'API: 実行環境',
        left: [usage('EndpointActiveEnvironments', 'Maximum'), web('EnvironmentConcurrentRequests', 'Maximum', { FunctionName: functionName })],
        right: [throttles],
        width: 12,
      }),
      new cloudwatch.GraphWidget({ title: 'API: メモリ（MB）と CPU 時間（ms）', left: [web('EnvironmentMaxMemoryUsage', 'Maximum', { FunctionName: functionName })], right: [web('EnvironmentCPUTime', 'Sum', { FunctionName: functionName })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'DB: ACU と接続数', left: [cluster.metricServerlessDatabaseCapacity({ statistic: 'Maximum' }), cluster.metricACUUtilization()], right: [cluster.metricDatabaseConnections({ statistic: 'Maximum' })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'DB: デッドロックと CPU', left: [cluster.metric('Deadlocks', { statistic: 'Sum' })], right: [cluster.metricCPUUtilization()], width: 12 }),
      new cloudwatch.LogQueryWidget({
        title: '最近の 5xx（ルートとビルド）',
        logGroupNames: [logGroup.logGroupName],
        queryLines: ['fields @timestamp, requestId, message.route, message.status, message.build, message.durationMs', 'filter message.type = "request" and message.status >= 500', 'sort @timestamp desc', 'limit 20'],
        width: 24,
      }),
    )
  }
}

export type EdgeAlarmsStackProps = StackProps & { config: AppConfig; stage: EnvConfig; distributionId: string }

/** CloudFront のアラーム（メトリクスは us-east-1 にだけある）。通知先のチャットは MonitoringStack がこのトピックも購読する */
export class EdgeAlarmsStack extends Stack {
  readonly topic: sns.Topic

  constructor(scope: Construct, id: string, props: EdgeAlarmsStackProps) {
    super(scope, id, props)
    const { config, stage: env } = props
    this.topic = new sns.Topic(this, 'EdgeAlarms', { topicName: nameOf(config, env, 'edge-alarms'), enforceSSL: true })
    if (env.monitoring.alarmEmail) this.topic.addSubscription(new subscriptions.EmailSubscription(env.monitoring.alarmEmail))
    const rate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '5xxErrorRate',
      statistic: 'Average',
      dimensionsMap: { DistributionId: props.distributionId, Region: 'Global' },
      period: Duration.minutes(5),
    })
    const alarm = rate.createAlarm(this, 'Edge5xx', {
      alarmName: nameOf(config, env, 'edge-5xx-rate'),
      alarmDescription: 'CloudFront の 5xx の割合が 5 分間で 1% を超えた。オリジン（Web Function）か CloudFront かを切り分ける。403 が急に増えたら OAC かリソースポリシーを疑う',
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    alarm.addAlarmAction(new actions.SnsAction(this.topic))
    alarm.addOkAction(new actions.SnsAction(this.topic))
  }
}
