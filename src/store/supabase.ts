import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, ServiceAuth, Store, StoredIssue, UpsertOutcome, PollableService, PollStateUpdate, LatestNotification, NotificationRecord, StoredHeartbeat, HeartbeatRun } from '@/store/contracts'
import {
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
  rowToPollConfig,
  rowToHeartbeat,
} from '@/store/mapping'

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient<Database>) {}

  rawClient(): SupabaseClient<Database> {
    return this.client
  }

  async getService(serviceId: string): Promise<ServiceRecord | null> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .eq('id', serviceId)
      .maybeSingle()
    if (error) throw new Error(`getService failed: ${error.message}`)
    return data === null ? null : rowToService(data)
  }

  async getServiceByName(name: string): Promise<ServiceAuth | null> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .eq('name', name)
      .maybeSingle()
    if (error) throw new Error(`getServiceByName failed: ${error.message}`)
    return data === null ? null : { service: rowToService(data), webhookSecret: data.webhook_secret }
  }

  async upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome> {
    const externalId =
      typeof event.metadata.externalId === 'string' ? event.metadata.externalId : null
    const { data, error } = await this.client.rpc('upsert_issue_with_event', {
      p_service_id: event.serviceId,
      p_fingerprint: event.fingerprint,
      p_source: event.source,
      p_level: event.level,
      p_error_type: event.errorType,
      p_message: event.message,
      p_occurred_at: event.occurredAt,
      p_metadata: event.metadata as Json,
      // 產生型別把 p_external_id 標成必填 string（Postgres 對函式參數無 NOT NULL
      // 中繼資料，型別產生器因此推不出可為 null）。運行時仍照原語意送出 null 代表
      // 無 externalId；此處僅是編譯期型別轉換，不改變實際送出的值。
      p_external_id: externalId as string,
    })
    if (error) throw new Error(`upsert_issue_with_event failed: ${error.message}`)
    const outcome = data?.[0]
    if (outcome === undefined) throw new Error('upsert_issue_with_event returned no row')

    const { data: issueRow, error: issueError } = await this.client
      .from('issues')
      .select('*')
      .eq('id', outcome.issue_id)
      .single()
    if (issueError) throw new Error(`fetch issue failed: ${issueError.message}`)
    return { issue: rowToIssue(issueRow), created: outcome.created, duplicate: outcome.duplicate }
  }

  async loadRules(serviceId: string): Promise<TriageRule[]> {
    // service_id 欄位是規則作用域的唯一權威（Plan 2 review 驗收條件 #2）
    const { data, error } = await this.client
      .from('triage_rules')
      .select('*')
      .eq('enabled', true)
      .or(`service_id.eq.${serviceId},service_id.is.null`)
      .order('priority', { ascending: false })
    if (error) throw new Error(`loadRules failed: ${error.message}`)
    return data.map(ruleRowToTriageRule)
  }

  async updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void> {
    const { data, error } = await this.client
      .from('issues')
      .update({ severity, tags })
      .eq('id', issueId)
      .select('id')
    if (error) throw new Error(`updateIssueTriage failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown issue: ${issueId}`)
  }

  async updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status })
      .eq('id', issueId)
      .select('*')
    if (error) throw new Error(`updateIssueStatus failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown issue: ${issueId}`)
    return rowToIssue(data[0])
  }

  async listOpenIssues(serviceId: string): Promise<OpenIssue[]> {
    const { data, error } = await this.client
      .from('issues')
      .select('severity,status,last_seen')
      .eq('service_id', serviceId)
      .in('status', ['open', 'acknowledged'])
    if (error) throw new Error(`listOpenIssues failed: ${error.message}`)
    return data.map((row) => ({
      severity: narrowSeverity(row.severity),
      status: narrowIssueStatus(row.status),
      lastSeen: row.last_seen,
    }))
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const { data, error } = await this.client
      .from('services')
      .update({ health_status: health })
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updateServiceHealth failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown service: ${serviceId}`)
  }

  async listPollableServices(): Promise<PollableService[]> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .or('poll_health_url.not.is.null,poll_error_url.not.is.null')
    if (error) throw new Error(`listPollableServices failed: ${error.message}`)
    return data.map((row) => ({
      service: rowToService(row),
      config: rowToPollConfig(row),
      lastPollAt: row.last_poll_at,
    }))
  }

  async updatePollState(serviceId: string, state: PollStateUpdate): Promise<void> {
    const patch: Database['public']['Tables']['services']['Update'] = {
      last_poll_at: state.lastPollAt,
      last_poll_healthy: state.healthy,
      poll_consecutive_failures: state.consecutiveFailures,
    }
    if (state.cursor !== undefined) patch.poll_cursor = state.cursor
    const { data, error } = await this.client
      .from('services')
      .update(patch)
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updatePollState failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown service: ${serviceId}`)
  }

  async resolveHealthCheckIssue(serviceId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status: 'resolved' })
      .eq('service_id', serviceId)
      .eq('error_type', 'health_check_failed')
      .in('status', ['open', 'acknowledged'])
      .select('id')
    if (error) throw new Error(`resolveHealthCheckIssue failed: ${error.message}`)
    return data.length > 0
  }

  async getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
  ): Promise<LatestNotification | null> {
    const { data, error } = await this.client
      .from('notifications')
      .select('severity,sent_at')
      .eq('service_id', serviceId)
      .eq('fingerprint', fingerprint)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`getLatestSentNotification failed: ${error.message}`)
    return data === null ? null : { severity: narrowSeverity(data.severity), sentAt: data.sent_at }
  }

  async recordNotification(record: NotificationRecord): Promise<void> {
    const { error } = await this.client.from('notifications').insert({
      issue_id: record.issueId,
      service_id: record.serviceId,
      fingerprint: record.fingerprint,
      severity: record.severity,
      status: record.status,
      count_at_send: record.countAtSend,
      sent_at: record.sentAt,
    })
    if (error) throw new Error(`recordNotification failed: ${error.message}`)
  }

  async listEnabledHeartbeats(): Promise<StoredHeartbeat[]> {
    const { data, error } = await this.client.from('heartbeats').select('*').eq('enabled', true)
    if (error) throw new Error(`listEnabledHeartbeats failed: ${error.message}`)
    return data.map(rowToHeartbeat)
  }

  async listHeartbeatsByService(serviceId: string): Promise<StoredHeartbeat[]> {
    const { data, error } = await this.client
      .from('heartbeats')
      .select('*')
      .eq('service_id', serviceId)
      .order('name')
    if (error) throw new Error(`listHeartbeatsByService failed: ${error.message}`)
    return data.map(rowToHeartbeat)
  }

  async recordHeartbeatRun(
    serviceId: string,
    name: string,
    run: HeartbeatRun,
  ): Promise<StoredHeartbeat | null> {
    const patch = {
      last_run_at: run.at,
      last_run_status: run.status,
      last_run_url: run.runUrl,
      // pass 才推進 last_success_at；fail 不帶這個鍵，保留舊值
      ...(run.status === 'pass' ? { last_success_at: run.at } : {}),
    }
    const { data, error } = await this.client
      .from('heartbeats')
      .update(patch)
      .eq('service_id', serviceId)
      .eq('name', name)
      .select('*')
    if (error) throw new Error(`recordHeartbeatRun failed: ${error.message}`)
    return data.length === 0 ? null : rowToHeartbeat(data[0])
  }

  async resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status: 'resolved' })
      .eq('service_id', serviceId)
      .eq('fingerprint', fingerprint)
      .in('status', ['open', 'acknowledged'])
      .select('id')
    if (error) throw new Error(`resolveIssueByFingerprint failed: ${error.message}`)
    return data.length > 0
  }
}
