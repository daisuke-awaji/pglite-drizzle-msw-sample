import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as logs from 'aws-cdk-lib/aws-logs'
import type { Construct } from 'constructs'
import { nameOf, type AppConfig, type EnvConfig } from './config.ts'

export type NetworkStackProps = StackProps & { config: AppConfig; stage: EnvConfig }

/**
 * VPC。インターネットへの出口（NAT Gateway・Internet Gateway）は置かない。
 * - app サブネット: Web Function の Network Connector、migrate / db-bootstrap 関数、ローテーションの関数
 * - db サブネット: Aurora
 * - 外に出るのは Secrets Manager だけなので、VPC endpoint を置く（ログは Lambda が集めるので VPC を通らない）
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc
  readonly appSubnets: ec2.SubnetSelection
  readonly dbSubnets: ec2.SubnetSelection
  /** Network Connector（Web Function の外向きの通信） */
  readonly connectorSg: ec2.SecurityGroup
  /** migrate / db-bootstrap / ローテーションの関数 */
  readonly jobsSg: ec2.SecurityGroup
  readonly dbSg: ec2.SecurityGroup

  // AZ はアカウントに問い合わせず（lookup しない）名前で決める。CI の synth は資格情報なしで動く。
  // CloudFormation の検査（W3010: AZ の決め打ち）は警告になるが、わざとそうしている
  override get availabilityZones(): string[] {
    return ['a', 'c', 'd'].map((z) => `${this.region}${z}`)
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)
    const { config, stage: env } = props

    const flowLogs = new logs.LogGroup(this, 'FlowLogs', {
      retention: env.logRetentionDays as logs.RetentionDays,
      removalPolicy: env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    })

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: nameOf(config, env, 'vpc'),
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 3,
      natGateways: 0,
      // Network Connector の名前解決と、Secrets Manager の VPC endpoint（プライベート DNS）に要る
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: { all: { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs), trafficType: ec2.FlowLogTrafficType.REJECT } },
      restrictDefaultSecurityGroup: true,
    })
    this.appSubnets = { subnetGroupName: 'app' }
    this.dbSubnets = { subnetGroupName: 'db' }

    const sg = (name: string, description: string) =>
      new ec2.SecurityGroup(this, name, { vpc: this.vpc, description, allowAllOutbound: false, securityGroupName: nameOf(config, env, name.toLowerCase()) })
    this.connectorSg = sg('ConnectorSg', 'Web Function (API) egress through the Network Connector')
    this.jobsSg = sg('JobsSg', 'migrate / db-bootstrap / secret rotation functions')
    this.dbSg = sg('DbSg', 'Aurora PostgreSQL')
    const endpointSg = sg('EndpointSg', 'Interface VPC endpoints (Secrets Manager)')

    for (const client of [this.connectorSg, this.jobsSg]) {
      client.addEgressRule(this.dbSg, ec2.Port.tcp(5432), 'PostgreSQL')
      this.dbSg.addIngressRule(client, ec2.Port.tcp(5432), 'PostgreSQL')
      client.addEgressRule(endpointSg, ec2.Port.tcp(443), 'Secrets Manager')
      endpointSg.addIngressRule(client, ec2.Port.tcp(443), 'Secrets Manager')
    }

    this.vpc.addInterfaceEndpoint('SecretsManager', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: this.appSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
      open: false,
    })
  }
}
