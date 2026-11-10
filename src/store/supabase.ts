import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { DiscordMessage } from '@/notify/message'
import type { ServiceRecord, ServiceAuth, Store, StoredIssue, UpsertOutcome, PollableService, PollStateUpdate, LatestNotification, NotificationRecord, StoredHeartbeat, HeartbeatRun, RegisteredService, NewHeartbeat, IssueAiTriage, IncidentRoot } from '@/store/contracts'
import {
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
  rowToPollConfig,
  rowToHeartbeat,
} from '@/store/mapping'

/** Postgres unique_violation。名稱重複是預期輸入，不是例外。 */
const UNIQUE_VIOLATION = '23505'

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
    return {
      issue: rowToIssue(issueRow),
      created: outcome.created,
      duplicate: outcome.duplicate,
      reopened: outcome.reopened,
    }
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

  async listOpenIssues(serviceId: string): Promise<OpenIssue[]> {
    const { data, error } = await this.client
      .from('issues')
      .select('severity,status,last_seen,error_type')
      .eq('service_id', serviceId)
      .in('status', ['open', 'acknowledged'])
    if (error) throw new Error(`listOpenIssues failed: ${error.message}`)
    return data.map((row) => ({
      severity: narrowSeverity(row.severity),
      status: narrowIssueStatus(row.status),
      lastSeen: row.last_seen,
      errorType: row.error_type,
    }))
  }

  async listRecentIssues(
    serviceId: string,
    sinceIso: string,
  ): Promise<Array<{ severity: Severity; status: IssueStatus; firstSeen: string; lastSeen: string }>> {
    const { data, error } = await this.client
      .from('issues')
      .select('severity,status,first_seen,last_seen')
      .eq('service_id', serviceId)
      .gte('last_seen', sinceIso)
    if (error) throw new Error(`listRecentIssues failed: ${error.message}`)
    return data.map((row) => ({
      severity: narrowSeverity(row.severity),
      status: narrowIssueStatus(row.status),
      firstSeen: row.first_seen,
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

  async getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
    incidentSeq: number,
  ): Promise<LatestNotification | null> {
    const { data, error } = await this.client
      .from('notifications')
      .select('severity,sent_at')
      .eq('service_id', serviceId)
      .eq('fingerprint', fingerprint)
      .eq('status', 'sent')
      .eq('incident_seq', incidentSeq)
      .in('kind', ['alert', 'count_edit'])
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`getLatestSentNotification failed: ${error.message}`)
    return data === null ? null : { severity: narrowSeverity(data.severity), sentAt: data.sent_at }
  }

  async getIssue(issueId: string): Promise<StoredIssue | null> {
    const { data, error } = await this.client.from('issues').select('*').eq('id', issueId).maybeSingle()
    if (error) throw new Error(`getIssue failed: ${error.message}`)
    return data === null ? null : rowToIssue(data)
  }

  async getIncidentRoot(issueId: string, incidentSeq: number): Promise<IncidentRoot | null> {
    const { data, error } = await this.client
      .from('notifications')
      .select('discord_channel_id,discord_message_id,payload')
      .eq('issue_id', issueId)
      .eq('incident_seq', incidentSeq)
      .eq('kind', 'alert')
      .eq('status', 'sent')
      .not('discord_message_id', 'is', null)
      .order('sent_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`getIncidentRoot failed: ${error.message}`)
    if (data === null || data.discord_message_id === null || data.payload === null) return null
    return {
      channelId: data.discord_channel_id ?? '',
      messageId: data.discord_message_id,
      payload: data.payload as unknown as DiscordMessage,
    }
  }

  async transitionIssueStatus(
    issueId: string,
    to: IssueStatus,
    allowedFrom: readonly IssueStatus[],
    actor: string | null,
    nowIso: string,
  ): Promise<{ issue: StoredIssue; changed: boolean } | null> {
    const patch: Database['public']['Tables']['issues']['Update'] = { status: to }
    if (to === 'acknowledged') {
      patch.acknowledged_at = nowIso
      patch.acknowledged_by = actor
    } else if (to === 'resolved') {
      patch.resolved_at = nowIso
      patch.resolved_by = actor
    } else if (to === 'open') {
      patch.acknowledged_at = null
      patch.acknowledged_by = null
      patch.resolved_at = null
      patch.resolved_by = null
    }
    const { data, error } = await this.client
      .from('issues')
      .update(patch)
      .eq('id', issueId)
      .in('status', [...allowedFrom])
      .select('*')
    if (error) throw new Error(`transitionIssueStatus failed: ${error.message}`)
    if (data.length > 0) return { issue: rowToIssue(data[0]), changed: true }
    const { data: current, error: readError } = await this.client
      .from('issues')
      .select('*')
      .eq('id', issueId)
      .maybeSingle()
    if (readError) throw new Error(`transitionIssueStatus read failed: ${readError.message}`)
    return current === null ? null : { issue: rowToIssue(current), changed: false }
  }

  async findActiveIssueIds(
    serviceId: string,
    match: { fingerprint: string } | { errorType: 'health_check_failed' },
  ): Promise<string[]> {
    let query = this.client
      .from('issues')
      .select('id')
      .eq('service_id', serviceId)
      .in('status', ['open', 'acknowledged'])
    query =
      'fingerprint' in match
        ? query.eq('fingerprint', match.fingerprint)
        : query.eq('error_type', match.errorType)
    const { data, error } = await query
    if (error) throw new Error(`findActiveIssueIds failed: ${error.message}`)
    return data.map((r) => r.id)
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
      kind: record.kind,
      incident_seq: record.incidentSeq,
      discord_channel_id: record.discordChannelId,
      discord_message_id: record.discordMessageId,
      payload: record.payload === null ? null : (record.payload as unknown as Json),
    })
    if (error) throw new Error(`recordNotification failed: ${error.message}`)
  }

  async listEnabledHeartbeats(): Promise<StoredHeartbeat[]> {
    const { data, error } = await this.client.from('heartbeats').select('*').eq('enabled', true)
    if (error) throw new Error(`listEnabledHeartbeats failed: ${error.message}`)
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
      last_run_summary: run.summary,
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

  // ---- 後台登記 ----

  async createService(
    name: string,
    webhookSecret: string,
    description: string | null,
    ownerDiscordId: string | null = null,
  ): Promise<ServiceRecord | null> {
    const { data, error } = await this.client
      .from('services')
      .insert({ name, webhook_secret: webhookSecret, description, owner_discord_id: ownerDiscordId })
      .select('*')
      .maybeSingle()
    // 交給 DB 的 unique 約束判重複，而不是先 select 再 insert——後者在兩人同時送出時
    // 會雙雙通過檢查，然後其中一個以未處理的 500 收場。
    if (error !== null) {
      if (error.code === UNIQUE_VIOLATION) return null
      throw new Error(`createService failed: ${error.message}`)
    }
    return data === null ? null : rowToService(data)
  }

  async createHeartbeat(
    serviceId: string,
    heartbeat: NewHeartbeat,
  ): Promise<StoredHeartbeat | null> {
    const { data, error } = await this.client
      .from('heartbeats')
      .insert({
        service_id: serviceId,
        name: heartbeat.name,
        interval_seconds: heartbeat.intervalSeconds,
        grace_seconds: heartbeat.graceSeconds,
      })
      .select('*')
      .maybeSingle()
    if (error !== null) {
      if (error.code === UNIQUE_VIOLATION) return null
      throw new Error(`createHeartbeat failed: ${error.message}`)
    }
    return data === null ? null : rowToHeartbeat(data)
  }

  async updateServiceDescription(serviceId: string, description: string | null): Promise<boolean> {
    const { data, error } = await this.client
      .from('services')
      .update({ description })
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updateServiceDescription failed: ${error.message}`)
    return data.length > 0
  }

  async updateServiceOwner(serviceId: string, ownerDiscordId: string | null): Promise<boolean> {
    const { data, error } = await this.client
      .from('services')
      .update({ owner_discord_id: ownerDiscordId })
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updateServiceOwner failed: ${error.message}`)
    return data.length > 0
  }

  async recordIssueAiTriage(issueId: string, triage: IssueAiTriage): Promise<void> {
    const { data, error } = await this.client
      .from('issues')
      .update({
        ai_severity: triage.severity,
        ai_category: triage.category,
        ai_reason: triage.reason,
        ai_suggestion: triage.suggestion,
        ai_model: triage.model,
        ai_judged_at: triage.judgedAt,
        ai_error: triage.error,
      })
      .eq('id', issueId)
      .select('id')
    if (error) throw new Error(`recordIssueAiTriage failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown issue: ${issueId}`)
  }

  async rotateWebhookSecret(serviceId: string, webhookSecret: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('services')
      .update({ webhook_secret: webhookSecret })
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`rotateWebhookSecret failed: ${error.message}`)
    return data.length > 0
  }

  async listRegisteredServices(): Promise<RegisteredService[]> {
    const [services, heartbeats] = await Promise.all([
      this.client.from('services').select('*').order('name'),
      this.client.from('heartbeats').select('*').order('name'),
    ])
    if (services.error) throw new Error(`listRegisteredServices failed: ${services.error.message}`)
    if (heartbeats.error) throw new Error(`listRegisteredServices failed: ${heartbeats.error.message}`)

    const byService = new Map<string, StoredHeartbeat[]>()
    for (const row of heartbeats.data) {
      const hb = rowToHeartbeat(row)
      const bucket = byService.get(hb.serviceId)
      if (bucket === undefined) byService.set(hb.serviceId, [hb])
      else bucket.push(hb)
    }
    return services.data.map((row) => ({
      id: row.id,
      name: row.name,
      hasWebhookSecret: row.webhook_secret !== null,
      description: row.description,
      ownerDiscordId: row.owner_discord_id,
      createdAt: row.created_at,
      heartbeats: byService.get(row.id) ?? [],
    }))
  }
}
