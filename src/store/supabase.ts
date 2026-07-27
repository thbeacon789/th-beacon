import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, ServiceAuth, Store, StoredIssue, UpsertOutcome } from '@/store/contracts'
import {
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
} from '@/store/mapping'

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient<Database>) {}

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
    const { error } = await this.client
      .from('issues')
      .update({ severity, tags })
      .eq('id', issueId)
    if (error) throw new Error(`updateIssueTriage failed: ${error.message}`)
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
    const { error } = await this.client
      .from('services')
      .update({ health_status: health })
      .eq('id', serviceId)
    if (error) throw new Error(`updateServiceHealth failed: ${error.message}`)
  }
}
