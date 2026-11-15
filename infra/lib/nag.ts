import { Aspects, CfnResource, Validations, type IAspect, type Stack } from 'aws-cdk-lib'
import { rules } from 'cdk-nag'
import type { IConstruct } from 'constructs'
import type { EnvConfig } from './config.ts'

/**
 * cdk-nag（AWS Solutions）の指摘のうち、理由があって認めるもの。
 * 認めるのは、その指摘が出る construct だけにする（スタック全体には付けない）。理由は docs/production.md の決めたことに合わせる。
 * 新しい指摘が出たら、まず直す。直せないときだけここに理由を書いて足す（infra/test/nag.test.ts が、指摘が残っていないことを確かめる）
 */
type Ack = {
  stack: string
  path: string
  id: string
  reason: string
  /**
   * IAM4・IAM5 は 1 つの資源に複数の指摘（ワイルドカード・マネージドポリシーごと）が出る。
   * 認めるのは、この正規表現に合う指摘だけ（合わない新しいワイルドカードは指摘されたまま残る）
   */
  findings?: RegExp
  /** この環境のときだけ認める（例: dev・stg だけ MFA を任意にする） */
  onlyIf?: (env: EnvConfig) => boolean
}

/** 1 つの資源に複数の指摘を出すルールと、その指摘を計算する cdk-nag のルール */
const GRANULAR: Record<string, (node: CfnResource) => unknown> = {
  'AwsSolutions-IAM4': rules.iam.IAMNoManagedPolicies,
  'AwsSolutions-IAM5': rules.iam.IAMNoWildcardPermissions,
}

const lambdaInVpc = 'VPC の中の Lambda 関数に要る ENI とログの権限（AWSLambdaBasicExecutionRole・AWSLambdaVPCAccessExecutionRole）。CDK が付ける'
const logRetention = 'Aurora のログ（/aws/rds/cluster/...）の保存期間を設定する CDK の関数。ロググループは RDS が作るので、名前を前もって絞れない'

export const ACKNOWLEDGEMENTS: Ack[] = [
  // --- 実行ロールとネットワーク ---
  {
    stack: 'Api',
    path: 'ExecutionRole/DefaultPolicy/Resource',
    id: 'AwsSolutions-IAM5',
    findings: /^Resource::<(Local)?LogGroup[0-9A-F]+\.Arn>:\*$/,
    reason: 'ログストリームの名前は Lambda が決めるので、自分のロググループ（/aws/lambda/web/<関数名> と .local）の下の :* だけを許す',
  },
  {
    stack: 'Api',
    path: 'ConnectorOperatorRole/DefaultPolicy/Resource',
    id: 'AwsSolutions-IAM5',
    findings: /^Resource::arn:<AWS::Partition>:ec2:[a-z0-9-]+:\d{12}:network-interface\/\*$/,
    reason: 'Network Connector の ENI は Lambda が作るので ID が決まらない。公式の手順のとおり network-interface/* に限り、タグは ec2:ManagedResourceOperator の条件で絞る',
  },
  {
    stack: 'Api',
    path: 'CodeBucket/Resource',
    id: 'AwsSolutions-S1',
    reason: 'コードの zip を置くのは GitHub Actions のデプロイ用ロールだけで、操作は CloudTrail に残る。バージョニングを有効にして上書きしない',
  },
  // --- マイグレーションの実行役 ---
  ...(['Migrate', 'DbBootstrap'] as const).flatMap((fn): Ack[] => [
    { stack: 'Migrate', path: `${fn}/ServiceRole/Resource`, id: 'AwsSolutions-IAM4', reason: lambdaInVpc, findings: /^Policy::arn:<AWS::Partition>:iam::aws:policy\/service-role\/AWSLambda(Basic|VPCAccess)ExecutionRole$/ },
    { stack: 'Migrate', path: `${fn}/Resource`, id: 'AwsSolutions-L1', reason: 'API（Lambda Web Functions）は nodejs24.x だけなので、同じコードを同じ Node 24 で動かす' },
  ]),
  // --- DB ---
  {
    stack: 'Data',
    path: 'Cluster/Resource',
    id: 'AwsSolutions-RDS6',
    reason: 'IAM 認証は新しい接続の数に上限があり、実行環境の増減で接続を作り直すこの構成に合わない。Secrets Manager のパスワード（交互に使うローテーション）にする（docs/production.md「設計の判断」）',
  },
  { stack: 'Data', path: 'Cluster/Resource', id: 'AwsSolutions-RDS10', reason: 'dev は使い捨ての環境なので削除保護を付けない（stg・prod は付ける）' },
  { stack: 'Data', path: 'Cluster/MonitoringRole/Resource', id: 'AwsSolutions-IAM4', reason: '拡張モニタリング（prod）に RDS が要求する AmazonRDSEnhancedMonitoringRole', findings: /AmazonRDSEnhancedMonitoringRole$/ },
  { stack: 'Data', path: 'MonthlyPlan/Cluster/Role/Resource', id: 'AwsSolutions-IAM4', reason: 'AWS Backup の既定のロール（AWSBackupServiceRolePolicyForBackup）', findings: /AWSBackupServiceRolePolicyForBackup$/ },
  { stack: 'Data', path: 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/Resource', id: 'AwsSolutions-IAM4', reason: logRetention, findings: /AWSLambdaBasicExecutionRole$/ },
  { stack: 'Data', path: 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/DefaultPolicy/Resource', id: 'AwsSolutions-IAM5', reason: logRetention, findings: /^Resource::\*$/ },
  // --- 入口 ---
  {
    stack: 'Edge',
    path: 'Distribution/Resource',
    id: 'AwsSolutions-CFR4',
    reason: '独自ドメインがない環境は CloudFront の既定の証明書（*.cloudfront.net）になり、最小の TLS を選べない。独自ドメインでは TLSv1.2_2021 にする',
  },
  {
    stack: 'Edge',
    path: 'Distribution/Resource',
    id: 'AwsSolutions-CFR1',
    reason: '国で止めるかは案件ごとに決める（WAF の IP の制限で入口を絞れる。lib/config.ts の waf.allowedCidrs）',
  },
  {
    stack: 'Auth',
    path: 'UserPool/Resource',
    id: 'AwsSolutions-COG2',
    reason: 'dev・stg は試験用の利用者だけなので MFA は任意（prod は必須にする。lib/config.ts の auth.mfaRequired）',
    onlyIf: (env) => !env.auth.mfaRequired,
  },
  {
    stack: 'Auth',
    path: 'UserPool/Resource',
    id: 'AwsSolutions-COG8',
    reason: '利用者は管理者が招待し、自分では登録できない。脅威の保護（Plus）は費用と合わせて案件ごとに決める（docs/production.md「未確定のこと」）',
  },
  // --- デプロイ用のロール ---
  {
    stack: 'Ci',
    path: 'DeployRole/DefaultPolicy/Resource',
    id: 'AwsSolutions-IAM5',
    findings: new RegExp(
      [
        String.raw`^Resource::arn:<AWS::Partition>:iam::\d{12}:role/cdk-hnb659fds-\*$`,
        String.raw`^Resource::arn:<AWS::Partition>:ssm:[a-z0-9-]+:\d{12}:parameter/[a-z0-9-]+/(dev|stg|prod)/(\*|api/\*-domain)$`,
        String.raw`^Resource::arn:aws:s3:::[a-z0-9-]+-(dev|stg|prod)-(code-\d{12}/(api|migrate)|site-\d{12})/\*$`,
        String.raw`^Resource::arn:<AWS::Partition>:lambda:[a-z0-9-]+:\d{12}:web-function/[a-z0-9-]+/\*$`,
        String.raw`^Resource::arn:<AWS::Partition>:lambda:[a-z0-9-]+:\d{12}:network-connector:\*$`,
        String.raw`^Resource::arn:<AWS::Partition>:cloudwatch:[a-z0-9-]+:\d{12}:alarm:[a-z0-9-]+-(dev|stg|prod)-\*$`,
      ].join('|'),
    ),
    reason:
      '名前の決まった範囲だけに * を使う: CDK の bootstrap のロール（cdk-hnb659fds-*）、この環境の SSM パラメーター（/<app>/<env>/*）、コードの api/・migrate/ の下、画面のバケットの中、この Web Function の revision と endpoint、Network Connector のバージョン、この環境のアラーム',
  },
]

function find(stack: Stack, path: string): IConstruct | undefined {
  let node: IConstruct | undefined = stack
  for (const part of path.split('/')) node = node?.node.tryFindChild(part)
  return node
}

/** 細かい指摘（IAM4・IAM5）を、正規表現に合うものだけ認める。cdk-nag と同じルールで指摘を計算する */
class AcknowledgeFindings implements IAspect {
  private readonly ack: Ack & { findings: RegExp }
  private readonly rule: (node: CfnResource) => unknown
  constructor(ack: Ack & { findings: RegExp }, rule: (node: CfnResource) => unknown) {
    this.ack = ack
    this.rule = rule
  }
  visit(node: IConstruct) {
    if (!CfnResource.isCfnResource(node)) return
    const result = this.rule(node)
    if (!Array.isArray(result)) return
    for (const finding of result as string[]) {
      if (this.ack.findings.test(finding)) Validations.of(node).acknowledge({ id: `${this.ack.id}[${finding}]`, reason: this.ack.reason })
    }
  }
}

/** スタックの名前の末尾（Api・Data など）で ACKNOWLEDGEMENTS を当てる。見つからないもの（prod だけの資源など）は飛ばす */
export function acknowledgeNagFindings(stacks: Record<string, Stack>, env: EnvConfig): number {
  let applied = 0
  for (const ack of ACKNOWLEDGEMENTS) {
    if (ack.onlyIf && !ack.onlyIf(env)) continue
    const stack = stacks[ack.stack]
    const target = stack && find(stack, ack.path)
    if (!target) continue
    const rule = GRANULAR[ack.id]
    if (rule) {
      if (!ack.findings) throw new Error(`${ack.id} は findings（認める指摘の正規表現）が要ります: ${ack.stack}/${ack.path}`)
      Aspects.of(target).add(new AcknowledgeFindings({ ...ack, findings: ack.findings }, rule))
    } else {
      Validations.of(target).acknowledge({ id: ack.id, reason: ack.reason })
    }
    applied++
  }
  return applied
}
