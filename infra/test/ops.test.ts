import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import {
  CreateDBInstanceCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  RestoreDBClusterToPointInTimeCommand,
} from '@aws-sdk/client-rds'
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm'
import { mockClient } from 'aws-sdk-client-mock'
import { context, createClients } from '../scripts/deploy/lib.ts'
import { deleteDrill, restoreDrill } from '../scripts/ops/restore-drill.ts'

// 復元の練習（AWS の呼び出しを置き換える）。本番のクラスターに書かず、新しいクラスターを作って最後に消すこと
const rdsMock = mockClient(RDSClient)
const lambda = mockClient(LambdaClient)
const ssm = mockClient(SSMClient)
const rds = new RDSClient({ region: 'ap-northeast-1' })
const clients = createClients('ap-northeast-1')
const ctx = context('stg', 'tasks')

beforeEach(() => {
  rdsMock.reset()
  lambda.reset()
  ssm.reset()
  rdsMock.on(DescribeDBClustersCommand, { DBClusterIdentifier: 'tasks-stg-db' }).resolves({
    DBClusters: [{ DBClusterIdentifier: 'tasks-stg-db', Engine: 'aurora-postgresql', DBSubnetGroup: 'sg-group', VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-db' }], KmsKeyId: 'arn:kms', DBClusterParameterGroup: 'params', ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 8 } }],
  })
  rdsMock.on(DescribeDBClustersCommand, { DBClusterIdentifier: 'tasks-stg-drill-202611150900' }).resolves({ DBClusters: [{ Status: 'available', Endpoint: 'drill.cluster.example' }] })
  rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceStatus: 'available' }] })
  rdsMock.on(RestoreDBClusterToPointInTimeCommand).resolves({})
  rdsMock.on(CreateDBInstanceCommand).resolves({})
  rdsMock.on(DeleteDBInstanceCommand).resolves({})
  rdsMock.on(DeleteDBClusterCommand).resolves({})
  ssm.on(GetParametersCommand).resolves({ Parameters: [{ Name: '/tasks/stg/migrate/function-name', Value: 'tasks-stg-migrate' }] })
})

const now = () => new Date('2026-11-15T09:00:00Z')

describe('復元の練習', () => {
  test('新しいクラスターに復元し、migrate の verify で中身を読み、最後に消す', async () => {
    lambda.on(InvokeCommand).resolves({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, pending: [], counts: { projects: 3 } })) as never })
    const result = await restoreDrill({ clients, rds, ctx, now, waitSeconds: 60 })
    const restore = rdsMock.commandCalls(RestoreDBClusterToPointInTimeCommand)[0]!.args[0].input
    assert.equal(restore.DBClusterIdentifier, 'tasks-stg-drill-202611150900')
    assert.equal(restore.SourceDBClusterIdentifier, 'tasks-stg-db')
    assert.equal(restore.UseLatestRestorableTime, true)
    assert.deepEqual(restore.VpcSecurityGroupIds, ['sg-db'])
    assert.equal(restore.KmsKeyId, 'arn:kms')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(lambda.commandCalls(InvokeCommand)[0]!.args[0].input.Payload as Uint8Array)), { mode: 'verify', host: 'drill.cluster.example' })
    assert.equal(result.ok, true)
    assert.equal(rdsMock.commandCalls(DeleteDBClusterCommand)[0]!.args[0].input.DBClusterIdentifier, 'tasks-stg-drill-202611150900')
  })

  test('確かめに失敗しても、練習のクラスターは消す', async () => {
    lambda.on(InvokeCommand).resolves({ FunctionError: 'Unhandled', Payload: new TextEncoder().encode('{"errorMessage":"password authentication failed"}') as never })
    await assert.rejects(restoreDrill({ clients, rds, ctx, now, waitSeconds: 60 }), /password authentication failed/)
    assert.equal(rdsMock.commandCalls(DeleteDBClusterCommand).length, 1)
  })

  test('--keep なら残す。消せるのは練習のクラスターの名前だけ（本番のクラスターは消さない）', async () => {
    lambda.on(InvokeCommand).resolves({ Payload: new TextEncoder().encode('{"ok":true}') as never })
    await restoreDrill({ clients, rds, ctx, now, waitSeconds: 60, keep: true })
    assert.equal(rdsMock.commandCalls(DeleteDBClusterCommand).length, 0)
    await assert.rejects(deleteDrill(rds, 'tasks-stg-db'), /練習のクラスター/)
    assert.equal(rdsMock.commandCalls(DeleteDBClusterCommand).length, 0)
  })
})
