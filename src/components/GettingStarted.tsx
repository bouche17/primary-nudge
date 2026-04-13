import { useState } from "react";

const features = [
  {
    emoji: "👟",
    title: "PE days & recurring reminders",
    description: "Tell Monty about PE days, Forest School, reading books — anything that happens regularly. He'll remind you the evening before and morning of.",
    example: '"Jude has PE on Mondays and Harry on Thursdays"',
    color: "#F4A535",
    bg: "#FFF8EC",
  },
  {
    emoji: "🥪",
    title: "Weekly packed lunch check-in",
    description: "Every Sunday evening Monty will ask which days each child needs a packed lunch that week. Just reply naturally and he'll sort the reminders.",
    example: '"Jude needs one Tuesday and Thursday, Harry every day"',
    color: "#3B9E6A",
    bg: "#EEF9F3",
  },
  {
    emoji: "📲",
    title: "Forward from the school WhatsApp group",
    description: "See something in your school WhatsApp group? Forward it straight to Monty. He'll read it and save any dates or deadlines automatically.",
    example: "Just tap Forward → select Monty → send",
    color: "#5B8DEF",
    bg: "#EEF3FE",
  },
  {
    emoji: "🖼️",
    title: "Send a screenshot or photo",
    description: "Got a photo of a letter that came home, or a school event flyer? Send it to Monty and he'll extract the dates and save them for you.",
    example: "Take a photo of a school letter and send it",
    color: "#C15EDB",
    bg: "#F8EFFE",
  },
  {
    emoji: "📅",
    title: "Ask what's coming up",
    description: "Not sure what's on this week? Just ask. Monty knows your children's schedule and can tell you what's happening at any time.",
    example: '"What has Jude got on this week?"',
    color: "#E05C5C",
    bg: "#FEF0F0",
  },
  {
    emoji: "🔔",
    title: "Morning reminders, automatically",
    description: "You don't need to ask — Monty sends a WhatsApp each morning when there's something to remember. One message, everything in it.",
    example: "Good morning! 👟 Don't forget Jude's PE kit today",
    color: "#2A8FA8",
    bg: "#EBF6FA",
  },
];

interface GettingStartedProps {
  onDismiss: () => void;
}

export default function GettingStarted({ onDismiss }: GettingStartedProps) {
  return (
    <div style={{
      fontFamily: "'Georgia', 'Times New Roman', serif",
      maxWidth: 680,
      margin: "0 auto",
      padding: "0 20px 40px",
    }}>
      <div style={{
        textAlign: "center",
        padding: "40px 0 32px",
        borderBottom: "1px solid #F0EDE8",
        marginBottom: 32,
      }}>
        <div style={{ fontSize: 40, marginBottom: 12, lineHeight: 1 }}>🎒</div>
        <h1 style={{
          fontSize: 28,
          fontWeight: 400,
          color: "#1A1A18",
          margin: "0 0 10px",
          letterSpacing: "-0.5px",
        }}>
          You're all set up
        </h1>
        <p style={{
          fontSize: 16,
          color: "#6B6860",
          margin: "0 auto",
          lineHeight: 1.6,
          maxWidth: 420,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}>
          Monty is ready on WhatsApp. Here's everything he can do for you.
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))",
        gap: 14,
        marginBottom: 36,
      }}>
        {features.map((feature, i) => (
          <div key={i} style={{
            background: feature.bg,
            borderRadius: 14,
            padding: "20px 22px",
            border: `1px solid ${feature.color}22`,
          }}>
            <div style={{ fontSize: 26, marginBottom: 10, lineHeight: 1 }}>{feature.emoji}</div>
            <h3 style={{
              fontSize: 15,
              fontWeight: 600,
              color: "#1A1A18",
              margin: "0 0 8px",
              lineHeight: 1.3,
            }}>
              {feature.title}
            </h3>
            <p style={{
              fontSize: 14,
              color: "#5A5850",
              margin: "0 0 12px",
              lineHeight: 1.6,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            }}>
              {feature.description}
            </p>
            <div style={{
              background: "white",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              color: feature.color,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
              fontStyle: feature.example.startsWith('"') ? "italic" : "normal",
              borderLeft: `3px solid ${feature.color}`,
            }}>
              {feature.example}
            </div>
          </div>
        ))}
      </div>

      <div style={{
        background: "#F7F5F1",
        borderRadius: 16,
        padding: "24px 28px",
        marginBottom: 24,
        display: "flex",
        alignItems: "center",
        gap: 20,
        flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <p style={{
            fontSize: 15,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            color: "#1A1A18",
            margin: "0 0 4px",
            fontWeight: 500,
          }}>Ready to get started?</p>
          <p style={{
            fontSize: 14,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            color: "#6B6860",
            margin: 0,
            lineHeight: 1.5,
          }}>
            Open WhatsApp and say hello to Monty. Tell him about PE days or forward something from your school group.
          </p>
        </div>
        <a
          href="https://wa.me/447455730962"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "#25D366",
            color: "white",
            borderRadius: 10,
            padding: "11px 20px",
            fontSize: 14,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontWeight: 600,
            textDecoration: "none",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          Message Monty
        </a>
      </div>

      <div style={{ textAlign: "center" }}>
        <button
          onClick={onDismiss}
          style={{
            background: "none",
            border: "none",
            fontSize: 14,
            color: "#9E9B94",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            cursor: "pointer",
            padding: "8px 16px",
          }}
        >
          Got it, take me to my dashboard →
        </button>
      </div>
    </div>
  );
}
