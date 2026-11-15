import { Stack, type StackProps } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import type { Construct } from 'constructs'
import { nameOf, type AppConfig, type EnvConfig } from './config.ts'

const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName })

export type EdgeGlobalStackProps = StackProps & { config: AppConfig; stage: EnvConfig }

/**
 * CloudFront に付けるもので、us-east-1 に作る必要があるもの（ACM の証明書・WAF の Web ACL）。
 * WAF: AWS のマネージドルール（よくある攻撃・既知の悪い入力・IP の評判）と IP ごとの回数制限。
 * 最初の 2 週間は数えるだけ（count）にして誤検知を見てから止める（block）。docs/production.md「セキュリティの基本」
 */
export class EdgeGlobalStack extends Stack {
  readonly webAclArn: string
  readonly certificate?: acm.ICertificate

  constructor(scope: Construct, id: string, props: EdgeGlobalStackProps) {
    super(scope, id, props)
    const { config, stage: env } = props
    const count = env.waf.mode === 'count'
    const override = count ? { count: {} } : { none: {} }
    const action = count ? { count: {} } : { block: {} }

    const rules: wafv2.CfnWebACL.RuleProperty[] = []
    if (env.waf.allowedCidrs.length > 0) {
      // 認証の前に本番のデータを載せるとき: この CIDR 以外を止める（数えるだけにしない）
      const v4 = env.waf.allowedCidrs.filter((c) => !c.includes(':'))
      const v6 = env.waf.allowedCidrs.filter((c) => c.includes(':'))
      const sets = [
        ...(v4.length ? [new wafv2.CfnIPSet(this, 'AllowedV4', { scope: 'CLOUDFRONT', ipAddressVersion: 'IPV4', addresses: v4, name: nameOf(config, env, 'allowed-v4') })] : []),
        ...(v6.length ? [new wafv2.CfnIPSet(this, 'AllowedV6', { scope: 'CLOUDFRONT', ipAddressVersion: 'IPV6', addresses: v6, name: nameOf(config, env, 'allowed-v6') })] : []),
      ]
      const matches = sets.map((s) => ({ ipSetReferenceStatement: { arn: s.attrArn } }))
      rules.push({
        name: 'AllowListOnly',
        priority: 0,
        action: { block: {} },
        statement: { notStatement: { statement: matches.length === 1 ? matches[0]! : { orStatement: { statements: matches } } } },
        visibilityConfig: visibility('AllowListOnly'),
      })
    }
    const managed = (name: string, priority: number, excluded: string[] = []) => ({
      name,
      priority,
      overrideAction: override,
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, excludedRules: excluded.map((n) => ({ name: n })) } },
      visibilityConfig: visibility(name),
    })
    rules.push(
      managed('AWSManagedRulesAmazonIpReputationList', 10),
      // SizeRestrictions_BODY は 8 KB を超える本文を止める。API の上限（1 MB）はアプリが 413 で返すので外す
      managed('AWSManagedRulesCommonRuleSet', 20, ['SizeRestrictions_BODY']),
      managed('AWSManagedRulesKnownBadInputsRuleSet', 30),
      {
        name: 'RatePerIp',
        priority: 40,
        action,
        statement: { rateBasedStatement: { limit: env.waf.ratePer5Minutes, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
        visibilityConfig: visibility('RatePerIp'),
      },
    )

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: nameOf(config, env, 'edge'),
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      rules,
      visibilityConfig: visibility(nameOf(config, env, 'edge')),
    })
    this.webAclArn = acl.attrArn

    if (env.domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: env.domain.hostedZoneId, zoneName: env.domain.hostedZoneName })
      this.certificate = new acm.Certificate(this, 'Certificate', { domainName: env.domain.name, validation: acm.CertificateValidation.fromDns(zone) })
    }
  }
}
