import { Stack } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as kms from 'aws-cdk-lib/aws-kms'
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

/**
 * 秘密情報を読む権限を、使う側（IAM のポリシー）にだけ付ける。
 * secret.grantRead は KMS キーのキーポリシー（Data のスタック）に相手のロールを書くので、スタックをまたぐと循環参照になる。
 * 同じアカウントなので、キーポリシーはアカウントのルートを信頼する既定のままでよい
 */
export function grantSecretRead(grantee: iam.IGrantable, secrets: secretsmanager.ISecret[], key?: kms.IKey) {
  const stack = Stack.of(grantee as unknown as iam.Role)
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], resources: secrets.map((s) => s.secretArn) }),
  )
  if (key) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${stack.region}.amazonaws.com` } },
      }),
    )
  }
}
