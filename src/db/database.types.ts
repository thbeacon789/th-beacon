export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      allowed_emails: {
        Row: {
          created_at: string
          email: string
          note: string | null
        }
        Insert: {
          created_at?: string
          email: string
          note?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          note?: string | null
        }
        Relationships: []
      }
      events: {
        Row: {
          created_at: string
          error_type: string
          external_id: string | null
          id: string
          issue_id: string
          level: string
          message: string
          metadata: Json
          occurred_at: string
          service_id: string
          source: string
        }
        Insert: {
          created_at?: string
          error_type: string
          external_id?: string | null
          id?: string
          issue_id: string
          level: string
          message: string
          metadata?: Json
          occurred_at: string
          service_id: string
          source: string
        }
        Update: {
          created_at?: string
          error_type?: string
          external_id?: string | null
          id?: string
          issue_id?: string
          level?: string
          message?: string
          metadata?: Json
          occurred_at?: string
          service_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      heartbeats: {
        Row: {
          created_at: string
          enabled: boolean
          grace_seconds: number
          id: string
          interval_seconds: number
          last_run_at: string | null
          last_run_status: string | null
          last_run_url: string | null
          last_success_at: string | null
          name: string
          service_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          grace_seconds?: number
          id?: string
          interval_seconds: number
          last_run_at?: string | null
          last_run_status?: string | null
          last_run_url?: string | null
          last_success_at?: string | null
          name: string
          service_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          grace_seconds?: number
          id?: string
          interval_seconds?: number
          last_run_at?: string | null
          last_run_status?: string | null
          last_run_url?: string | null
          last_success_at?: string | null
          name?: string
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "heartbeats_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          count: number
          created_at: string
          error_type: string
          fingerprint: string
          first_seen: string
          id: string
          last_seen: string
          level: string
          message: string
          service_id: string
          severity: string
          status: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          count?: number
          created_at?: string
          error_type: string
          fingerprint: string
          first_seen: string
          id?: string
          last_seen: string
          level: string
          message: string
          service_id: string
          severity?: string
          status?: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          count?: number
          created_at?: string
          error_type?: string
          fingerprint?: string
          first_seen?: string
          id?: string
          last_seen?: string
          level?: string
          message?: string
          service_id?: string
          severity?: string
          status?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "issues_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          channel: string
          count_at_send: number
          fingerprint: string
          id: string
          issue_id: string | null
          sent_at: string
          service_id: string
          severity: string
          status: string
        }
        Insert: {
          channel?: string
          count_at_send: number
          fingerprint: string
          id?: string
          issue_id?: string | null
          sent_at?: string
          service_id: string
          severity: string
          status?: string
        }
        Update: {
          channel?: string
          count_at_send?: number
          fingerprint?: string
          id?: string
          issue_id?: string | null
          sent_at?: string
          service_id?: string
          severity?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          created_at: string
          discord_webhook_url: string | null
          health_failure_threshold: number
          health_status: string
          health_window_minutes: number
          id: string
          last_poll_at: string | null
          last_poll_healthy: boolean | null
          name: string
          poll_consecutive_failures: number
          poll_cursor: string | null
          poll_error_url: string | null
          poll_expected_status: number
          poll_health_url: string | null
          poll_interval_seconds: number | null
          poll_timeout_ms: number
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          created_at?: string
          discord_webhook_url?: string | null
          health_failure_threshold?: number
          health_status?: string
          health_window_minutes?: number
          id?: string
          last_poll_at?: string | null
          last_poll_healthy?: boolean | null
          name: string
          poll_consecutive_failures?: number
          poll_cursor?: string | null
          poll_error_url?: string | null
          poll_expected_status?: number
          poll_health_url?: string | null
          poll_interval_seconds?: number | null
          poll_timeout_ms?: number
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          created_at?: string
          discord_webhook_url?: string | null
          health_failure_threshold?: number
          health_status?: string
          health_window_minutes?: number
          id?: string
          last_poll_at?: string | null
          last_poll_healthy?: boolean | null
          name?: string
          poll_consecutive_failures?: number
          poll_cursor?: string | null
          poll_error_url?: string | null
          poll_expected_status?: number
          poll_health_url?: string | null
          poll_interval_seconds?: number | null
          poll_timeout_ms?: number
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: []
      }
      triage_rules: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          match: Json
          priority: number
          service_id: string | null
          severity: string
          tags: string[]
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          match: Json
          priority: number
          service_id?: string | null
          severity: string
          tags?: string[]
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          match?: Json
          priority?: number
          service_id?: string | null
          severity?: string
          tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "triage_rules_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      before_user_created_hook: { Args: { event: Json }; Returns: Json }
      upsert_issue_with_event: {
        Args: {
          p_error_type: string
          p_external_id: string
          p_fingerprint: string
          p_level: string
          p_message: string
          p_metadata: Json
          p_occurred_at: string
          p_service_id: string
          p_source: string
        }
        Returns: {
          created: boolean
          duplicate: boolean
          issue_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
