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
    PostgrestVersion: "14.1"
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
      parent_notes: {
        Row: {
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
        }
        Insert: {
          created_at?: string
          feed_type?: string
          feed_url: string
          id?: string
          label?: string | null
          last_synced_at?: string | null
          school_id?: string | null
        }
        Update: {
          created_at?: string
          feed_type?: string
          feed_url?: string
          id?: string
          label?: string | null
          last_synced_at?: string | null
          school_id?: string | null
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
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
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
