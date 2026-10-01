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
  public: {
    Tables: {
      bot_flows: {
        Row: {
          created_at: string
          id: string
          message_template: string
          next_step: string | null
          options: Json | null
          sort_order: number
          step_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_template: string
          next_step?: string | null
          options?: Json | null
          sort_order?: number
          step_name: string
        }
        Update: {
          created_at?: string
          id?: string
          message_template?: string
          next_step?: string | null
          options?: Json | null
          sort_order?: number
          step_name?: string
        }
        Relationships: []
      }
      child_reminders: {
        Row: {
          active: boolean | null
          anchor_date: string | null
          child_id: string
          created_at: string | null
          day_of_week: string
          emoji: string | null
          id: string
          parent_id: string
          recurrence_interval: number
          reminder_time: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          anchor_date?: string | null
          child_id: string
          created_at?: string | null
          day_of_week: string
          emoji?: string | null
          id?: string
          parent_id: string
          recurrence_interval?: number
          reminder_time?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          anchor_date?: string | null
          child_id?: string
          created_at?: string | null
          day_of_week?: string
          emoji?: string | null
          id?: string
          parent_id?: string
          recurrence_interval?: number
          reminder_time?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "child_reminders_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "children"
            referencedColumns: ["id"]
          },
        ]
      }
      children: {
        Row: {
          created_at: string
          first_name: string
          id: string
          parent_id: string
          school_id: string
          updated_at: string
          year_group: string
        }
        Insert: {
          created_at?: string
          first_name: string
          id?: string
          parent_id: string
          school_id: string
          updated_at?: string
          year_group: string
        }
        Update: {
          created_at?: string
          first_name?: string
          id?: string
          parent_id?: string
          school_id?: string
          updated_at?: string
          year_group?: string
        }
        Relationships: [
          {
            foreignKeyName: "children_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      consent_records: {
        Row: {
          consent_type: string
          consented_at: string
          id: string
          ip_address: string | null
          user_id: string
        }
        Insert: {
          consent_type?: string
          consented_at?: string
          id?: string
          ip_address?: string | null
          user_id: string
        }
        Update: {
          consent_type?: string
          consented_at?: string
          id?: string
          ip_address?: string | null
          user_id?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          context: Json
          created_at: string
          current_step: string
          id: string
          phone_number: string
          updated_at: string
        }
        Insert: {
          context?: Json
          created_at?: string
          current_step?: string
          id?: string
          phone_number: string
          updated_at?: string
        }
        Update: {
          context?: Json
          created_at?: string
          current_step?: string
          id?: string
          phone_number?: string
          updated_at?: string
        }
        Relationships: []
      }
      dedup_decisions: {
        Row: {
          child_name: string | null
          created_at: string
          decision: string
          id: string
          item_date: string | null
          matched_id: string | null
          matched_table: string | null
          matched_text: string | null
          new_item: string | null
          phone_number: string | null
          tool: string
        }
        Insert: {
          child_name?: string | null
          created_at?: string
          decision: string
          id?: string
          item_date?: string | null
          matched_id?: string | null
          matched_table?: string | null
          matched_text?: string | null
          new_item?: string | null
          phone_number?: string | null
          tool: string
        }
        Update: {
          child_name?: string | null
          created_at?: string
          decision?: string
          id?: string
          item_date?: string | null
          matched_id?: string | null
          matched_table?: string | null
          matched_text?: string | null
          new_item?: string | null
          phone_number?: string | null
          tool?: string
        }
        Relationships: []
      }
      event_exclusions: {
        Row: {
          child_id: string
          created_at: string
          id: string
          keyword: string
        }
        Insert: {
          child_id: string
          created_at?: string
          id?: string
          keyword: string
        }
        Update: {
          child_id?: string
          created_at?: string
          id?: string
          keyword?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_exclusions_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "children"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_tokens: {
        Row: {
          created_at: string | null
          email: string | null
          expires_at: string | null
          id: string
          inviter_user_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string
          inviter_user_id: string
          token?: string
          used_at?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string
          inviter_user_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      linked_accounts: {
        Row: {
          accepted_at: string | null
          id: string
          invited_at: string | null
          linked_user_id: string
          primary_user_id: string
          status: string
        }
        Insert: {
          accepted_at?: string | null
          id?: string
          invited_at?: string | null
          linked_user_id: string
          primary_user_id: string
          status?: string
        }
        Update: {
          accepted_at?: string | null
          id?: string
          invited_at?: string | null
          linked_user_id?: string
          primary_user_id?: string
          status?: string
        }
        Relationships: []
      }
      lunch_checkin_log: {
        Row: {
          id: string
          parent_id: string
          sent_at: string | null
          week_start: string
        }
        Insert: {
          id?: string
          parent_id: string
          sent_at?: string | null
          week_start: string
        }
        Update: {
          id?: string
          parent_id?: string
          sent_at?: string | null
          week_start?: string
        }
        Relationships: []
      }
      meal_menu: {
        Row: {
          category: string
          created_at: string
          day_of_week: string
          id: string
          item: string
          menu_name: string
          school_id: string | null
          week_number: number
        }
        Insert: {
          category: string
          created_at?: string
          day_of_week: string
          id?: string
          item: string
          menu_name: string
          school_id?: string | null
          week_number: number
        }
        Update: {
          category?: string
          created_at?: string
          day_of_week?: string
          id?: string
          item?: string
          menu_name?: string
          school_id?: string | null
          week_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "meal_menu_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_menu_cycle: {
        Row: {
          anchor_monday: string
          anchor_week_number: number
          id: string
          menu_name: string
          school_id: string | null
        }
        Insert: {
          anchor_monday: string
          anchor_week_number: number
          id?: string
          menu_name: string
          school_id?: string | null
        }
        Update: {
          anchor_monday?: string
          anchor_week_number?: number
          id?: string
          menu_name?: string
          school_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meal_menu_cycle_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      message_send_failures: {
        Row: {
          context: string | null
          created_at: string
          error_body: string | null
          function_name: string
          id: string
          period: string | null
          phone_number: string | null
          status_code: number | null
        }
        Insert: {
          context?: string | null
          created_at?: string
          error_body?: string | null
          function_name: string
          id?: string
          period?: string | null
          phone_number?: string | null
          status_code?: number | null
        }
        Update: {
          context?: string | null
          created_at?: string
          error_body?: string | null
          function_name?: string
          id?: string
          period?: string | null
          phone_number?: string | null
          status_code?: number | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          direction: string
          id: string
          message_type: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          message_type?: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          message_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      newsletter_log: {
        Row: {
          id: string
          newsletter_title: string | null
          newsletter_url: string
          notified_at: string | null
          school_id: string
        }
        Insert: {
          id?: string
          newsletter_title?: string | null
          newsletter_url: string
          notified_at?: string | null
          school_id: string
        }
        Update: {
          id?: string
          newsletter_title?: string | null
          newsletter_url?: string
          notified_at?: string | null
          school_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "newsletter_log_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_state: {
        Row: {
          collected_data: Json | null
          created_at: string | null
          current_child_index: number | null
          id: string
          phone_number: string
          status: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          collected_data?: Json | null
          created_at?: string | null
          current_child_index?: number | null
          id?: string
          phone_number: string
          status?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          collected_data?: Json | null
          created_at?: string | null
          current_child_index?: number | null
          id?: string
          phone_number?: string
          status?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      parent_notes: {
        Row: {
          child_name: string | null
          created_at: string | null
          extracted_actions: Json | null
          extracted_dates: Json | null
          id: string
          phone_number: string
          raw_content: string
          source_type: string
          summary: string | null
        }
        Insert: {
          child_name?: string | null
          created_at?: string | null
          extracted_actions?: Json | null
          extracted_dates?: Json | null
          id?: string
          phone_number: string
          raw_content: string
          source_type?: string
          summary?: string | null
        }
        Update: {
          child_name?: string | null
          created_at?: string | null
          extracted_actions?: Json | null
          extracted_dates?: Json | null
          id?: string
          phone_number?: string
          raw_content?: string
          source_type?: string
          summary?: string | null
        }
        Relationships: []
      }
      pending_family_updates: {
        Row: {
          actor_first_name: string | null
          actor_user_id: string
          created_at: string
          family_key: string
          id: string
          item_key: string | null
          processing_at: string | null
          sent_at: string | null
          summary: string
          updated_at: string
        }
        Insert: {
          actor_first_name?: string | null
          actor_user_id: string
          created_at?: string
          family_key: string
          id?: string
          item_key?: string | null
          processing_at?: string | null
          sent_at?: string | null
          summary: string
          updated_at?: string
        }
        Update: {
          actor_first_name?: string | null
          actor_user_id?: string
          created_at?: string
          family_key?: string
          id?: string
          item_key?: string | null
          processing_at?: string | null
          sent_at?: string | null
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          phone_number: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          phone_number?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          phone_number?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reminder_log: {
        Row: {
          id: string
          period: string
          phone_number: string
          reference_id: string | null
          reference_title: string | null
          reminder_type: string
          sent_at: string | null
        }
        Insert: {
          id?: string
          period: string
          phone_number: string
          reference_id?: string | null
          reference_title?: string | null
          reminder_type: string
          sent_at?: string | null
        }
        Update: {
          id?: string
          period?: string
          phone_number?: string
          reference_id?: string | null
          reference_title?: string | null
          reminder_type?: string
          sent_at?: string | null
        }
        Relationships: []
      }
      school_calendar_feeds: {
        Row: {
          created_at: string
          feed_type: string
          feed_url: string
          id: string
          label: string | null
          last_synced_at: string | null
          school_id: string | null
          year_group: string | null
        }
        Insert: {
          created_at?: string
          feed_type?: string
          feed_url: string
          id?: string
          label?: string | null
          last_synced_at?: string | null
          school_id?: string | null
          year_group?: string | null
        }
        Update: {
          created_at?: string
          feed_type?: string
          feed_url?: string
          id?: string
          label?: string | null
          last_synced_at?: string | null
          school_id?: string | null
          year_group?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "school_calendar_feeds_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      school_events: {
        Row: {
          all_day: boolean | null
          created_at: string
          description: string | null
          end_at: string | null
          feed_id: string | null
          id: string
          location: string | null
          school_id: string | null
          start_at: string
          title: string
          uid: string | null
          year_group: string | null
        }
        Insert: {
          all_day?: boolean | null
          created_at?: string
          description?: string | null
          end_at?: string | null
          feed_id?: string | null
          id?: string
          location?: string | null
          school_id?: string | null
          start_at: string
          title: string
          uid?: string | null
          year_group?: string | null
        }
        Update: {
          all_day?: boolean | null
          created_at?: string
          description?: string | null
          end_at?: string | null
          feed_id?: string | null
          id?: string
          location?: string | null
          school_id?: string | null
          start_at?: string
          title?: string
          uid?: string | null
          year_group?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "school_events_feed_id_fkey"
            columns: ["feed_id"]
            isOneToOne: false
            referencedRelation: "school_calendar_feeds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "school_events_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      school_holidays: {
        Row: {
          end_date: string
          id: string
          label: string
          school_id: string | null
          start_date: string
        }
        Insert: {
          end_date: string
          id?: string
          label: string
          school_id?: string | null
          start_date: string
        }
        Update: {
          end_date?: string
          id?: string
          label?: string
          school_id?: string | null
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "school_holidays_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      school_reminders: {
        Row: {
          active: boolean | null
          created_at: string
          day_of_week: string | null
          due_date: string | null
          emoji: string | null
          id: string
          school_id: string | null
          sort_order: number | null
          title: string
          updated_at: string
        }
        Insert: {
          active?: boolean | null
          created_at?: string
          day_of_week?: string | null
          due_date?: string | null
          emoji?: string | null
          id?: string
          school_id?: string | null
          sort_order?: number | null
          title: string
          updated_at?: string
        }
        Update: {
          active?: boolean | null
          created_at?: string
          day_of_week?: string | null
          due_date?: string | null
          emoji?: string | null
          id?: string
          school_id?: string | null
          sort_order?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "school_reminders_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      schools: {
        Row: {
          address: string | null
          created_at: string
          id: string
          local_authority: string | null
          name: string
          postcode: string
          urn: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          local_authority?: string | null
          name: string
          postcode: string
          urn: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          local_authority?: string | null
          name?: string
          postcode?: string
          urn?: string
        }
        Relationships: []
      }
      test_entry_audit: {
        Row: {
          allowed: boolean
          created_at: string
          entry_point: string
          id: string
          phone_number: string | null
          reason: string | null
          scenario: string | null
        }
        Insert: {
          allowed: boolean
          created_at?: string
          entry_point: string
          id?: string
          phone_number?: string | null
          reason?: string | null
          scenario?: string | null
        }
        Update: {
          allowed?: boolean
          created_at?: string
          entry_point?: string
          id?: string
          phone_number?: string | null
          reason?: string | null
          scenario?: string | null
        }
        Relationships: []
      }
      test_phone_numbers: {
        Row: {
          created_at: string
          label: string | null
          phone_number: string
        }
        Insert: {
          created_at?: string
          label?: string | null
          phone_number: string
        }
        Update: {
          created_at?: string
          label?: string | null
          phone_number?: string
        }
        Relationships: []
      }
      test_run_results: {
        Row: {
          category: string
          created_at: string
          details: Json | null
          id: string
          reason: string | null
          reply: string | null
          run_id: string
          scenario: string
          status: string
        }
        Insert: {
          category: string
          created_at?: string
          details?: Json | null
          id?: string
          reason?: string | null
          reply?: string | null
          run_id: string
          scenario: string
          status: string
        }
        Update: {
          category?: string
          created_at?: string
          details?: Json | null
          id?: string
          reason?: string | null
          reply?: string | null
          run_id?: string
          scenario?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_run_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "test_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      test_runner_tokens: {
        Row: {
          created_at: string
          expires_at: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          token_hash?: string
        }
        Relationships: []
      }
      test_runs: {
        Row: {
          failed: number
          finished_at: string | null
          flaky: number
          id: string
          notes: string | null
          passed: number
          started_at: string
          status: string
          suite: string
          total: number
          triggered_by: string | null
        }
        Insert: {
          failed?: number
          finished_at?: string | null
          flaky?: number
          id?: string
          notes?: string | null
          passed?: number
          started_at?: string
          status?: string
          suite?: string
          total?: number
          triggered_by?: string | null
        }
        Update: {
          failed?: number
          finished_at?: string | null
          flaky?: number
          id?: string
          notes?: string | null
          passed?: number
          started_at?: string
          status?: string
          suite?: string
          total?: number
          triggered_by?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      weekly_lunch_plans: {
        Row: {
          child_id: string
          created_at: string | null
          id: string
          packed_lunch_days: string[]
          parent_id: string
          updated_at: string | null
          week_start: string
        }
        Insert: {
          child_id: string
          created_at?: string | null
          id?: string
          packed_lunch_days?: string[]
          parent_id: string
          updated_at?: string | null
          week_start: string
        }
        Update: {
          child_id?: string
          created_at?: string | null
          id?: string
          packed_lunch_days?: string[]
          parent_id?: string
          updated_at?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_lunch_plans_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "children"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_family_updates: {
        Args: { _cap_minutes?: number; _quiet_minutes?: number }
        Returns: {
          actor_first_name: string | null
          actor_user_id: string
          created_at: string
          family_key: string
          id: string
          item_key: string | null
          processing_at: string | null
          sent_at: string | null
          summary: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "pending_family_updates"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      delete_parent_note: { Args: { _note_id: string }; Returns: boolean }
      get_family_user_ids: { Args: { _user_id: string }; Returns: string[] }
      get_partner_phones: {
        Args: { _user_id: string }
        Returns: {
          phone_number: string
          user_id: string
        }[]
      }
      get_upcoming_parent_notes: {
        Args: { _days?: number; _user_id: string }
        Returns: {
          child_name: string
          created_at: string
          event_date: string
          id: string
          raw_content: string
          summary: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      rollover_year_groups: { Args: never; Returns: undefined }
      test_send_reminders: { Args: { p?: string }; Returns: undefined }
    }
    Enums: {
      app_role: "admin" | "user"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
