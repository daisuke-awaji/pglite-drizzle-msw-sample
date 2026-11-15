import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { ApiStack } from './api.ts'
import { bucketOf, nameOf, paramOf, type AppConfig, type EnvConfig } from './config.ts'

export type EdgeStackProps = StackProps & {
  config: AppConfig
  stage: EnvConfig
  api: ApiStack
  webAclArn: string
  certificate?: acm.ICertificate
}

/** 画面の URL（/projects/1 など）を index.html に書き換える。ファイル名のある（. を含む）パスはそのまま */
export const SPA_REWRITE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf('.', uri.lastIndexOf('/')) === -1) request.uri = '/index.html';
  return request;
}`

/**
 * 1 つのドメインで画面と API を配る（docs/production.md「構成」）。
 * - /*: S3 の SPA（OAC。S3 は CloudFront からだけ読める）。ファイル名のないパスは CloudFront Function で index.html に
 * - /api/*: Web Function の live endpoint（OAC で SigV4 の署名を付ける。endpoint は IamAuth で、署名のないリクエストを断る）
 * - Web Function のリソースポリシーで、このディストリビューションだけに live の呼び出しを許す
 * カスタムエラーレスポンスは使わない（ディストリビューション全体に効き、API の 404 まで index.html にしてしまう）
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution
  readonly siteBucket: s3.Bucket
  readonly siteDomain: string

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props)
    const { config, stage: env, api } = props
    const retain = env.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

    const logBucket = new s3.Bucket(this, 'AccessLogs', {
      bucketName: bucketOf(config, env, 'logs'),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // CloudFront の標準ログは ACL で書き込む
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: retain,
      autoDeleteObjects: !env.deletionProtection,
      lifecycleRules: [{ expiration: Duration.days(env.logRetentionDays) }],
    })

    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: bucketOf(config, env, 'site'),
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 's3/site/',
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: retain,
      autoDeleteObjects: !env.deletionProtection,
      // 古いビルドの JS・CSS は消さない（開いたままの画面が読みに来る）。上書きされた古い版だけを消す
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
    })

    // デプロイの手順（bootstrap）が作った live endpoint のドメイン（*.lambda-web.ap-northeast-1.on.aws）
    const liveDomain = ssm.StringParameter.valueForStringParameter(this, paramOf(config, env, 'api/live-domain'))

    const apiOac = new cloudfront.CfnOriginAccessControl(this, 'ApiOac', {
      originAccessControlConfig: {
        name: nameOf(config, env, 'api-oac'),
        description: 'Sign origin requests to the Lambda Web Function (IamAuth)',
        originAccessControlOriginType: 'lambda',
        // Web Function のオリジンが受け付けるのはこれだけ。利用者の Authorization（Phase 4 の JWT）はそのまま渡る
        signingBehavior: 'always-amz-auth',
        signingProtocol: 'sigv4',
      },
    })

    // API は保存しない。GET・HEAD で利用者の Authorization を渡すには、キャッシュポリシーに入れる必要がある（OAC の決まり）。
    // TTL が 0 だとキーに項目を入れられないので最大 1 秒にし、API の Cache-Control: no-store で実際には保存させない
    const apiCache = new cloudfront.CachePolicy(this, 'ApiCache', {
      cachePolicyName: nameOf(config, env, 'api-no-cache'),
      comment: 'API: forward Authorization, effectively no caching (origin sends no-store)',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: nameOf(config, env, 'security-headers'),
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    })

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      functionName: nameOf(config, env, 'spa-rewrite'),
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.app} ${env.name}`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      webAclId: props.webAclArn,
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront/',
      // 最小の TLS は独自ドメインの証明書のときだけ選べる（既定の *.cloudfront.net は CloudFront が決める）
      ...(env.domain && props.certificate
        ? { domainNames: [env.domain.name], certificate: props.certificate, minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(liveDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            // API のリクエストの上限（30 秒）より少し長く
            readTimeout: Duration.seconds(35),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCache,
          // Host を送ると endpoint が 404 を返すので、Host だけ除いて送る
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
    })
    // HttpOrigin には OAC を付ける口がないので、2 つ目のオリジン（/api/*）に直接付ける
    const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.1.OriginAccessControlId', apiOac.attrId)

    // このディストリビューションだけに live の呼び出しを許す（Web Function のリソースポリシーは 1 つだけなので、ここで全体を持つ）
    const distributionArn = `arn:${this.partition}:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`
    new lambda.CfnResourcePolicy(this, 'ApiResourcePolicy', {
      resourceArn: api.functionArn,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOAC',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 'lambda:InvokeWebFunctionEndpoint',
            Resource: `${api.functionArn}/endpoint/live`,
            Condition: { StringEquals: { 'aws:SourceArn': distributionArn } },
          },
        ],
      },
    })

    if (env.domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: env.domain.hostedZoneId, zoneName: env.domain.hostedZoneName })
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution))
      new route53.ARecord(this, 'AliasA', { zone, recordName: env.domain.name, target })
      new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: env.domain.name, target })
    }
    this.siteDomain = env.domain?.name ?? this.distribution.distributionDomainName

    const param = (pid: string, name: string, value: string) => new ssm.StringParameter(this, pid, { parameterName: paramOf(config, env, name), stringValue: value })
    param('SiteBucketParam', 'web/site-bucket', this.siteBucket.bucketName)
    param('DistributionIdParam', 'web/distribution-id', this.distribution.distributionId)
    param('SiteDomainParam', 'web/site-domain', this.siteDomain)
  }
}
