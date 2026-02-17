import { motion } from "framer-motion";
import { Check, CheckCheck } from "lucide-react";

interface Message {
  from: "bot" | "user";
  text: string;
  time: string;
}

const messages: Message[] = [
  { from: "bot", text: "Good morning! 🌞 Just a reminder: tomorrow is World Book Day at St Mary's. Don't forget the costume! 📚", time: "7:30 AM" },
  { from: "user", text: "Oh thank you! What's the theme again?", time: "7:32 AM" },
  { from: "bot", text: "This year it's \"Favourite Characters\"! Also, PE kit needed on Wednesday and dinner money is due by Friday 💰", time: "7:32 AM" },
  { from: "user", text: "You're a lifesaver 🙏", time: "7:33 AM" },
  { from: "bot", text: "That's what I'm here for! I'll remind you again tomorrow morning 😊", time: "7:33 AM" },
];

const ChatMockup = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6 }}
      className="w-full max-w-sm mx-auto"
    >
      {/* Phone frame */}
      <div className="rounded-[2rem] bg-foreground/90 p-2 shadow-2xl shadow-primary/20">
        {/* Chat header */}
        <div className="rounded-t-[1.5rem] bg-primary px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary-foreground/20 flex items-center justify-center text-primary-foreground font-heading font-bold text-sm">
            M
          </div>
          <div>
            <p className="text-primary-foreground font-heading font-bold text-sm">Monty</p>
            <p className="text-primary-foreground/70 text-xs">online</p>
          </div>
        </div>

        {/* Chat area */}
        <div className="bg-brand-light p-3 space-y-2 min-h-[380px]">
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              whileInView={{ opacity: 1, y: 0, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15, duration: 0.3 }}
              className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${
                  msg.from === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-card text-card-foreground rounded-bl-sm"
                }`}
              >
                <p className="leading-relaxed">{msg.text}</p>
                <div className={`flex items-center justify-end gap-1 mt-1 ${msg.from === "user" ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                  <span className="text-[10px]">{msg.time}</span>
                  {msg.from === "user" && <CheckCheck className="w-3.5 h-3.5" />}
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Input bar */}
        <div className="rounded-b-[1.5rem] bg-card px-3 py-2 flex items-center gap-2">
          <div className="flex-1 bg-muted rounded-full px-4 py-2 text-xs text-muted-foreground">
            Type a message...
          </div>
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <svg className="w-4 h-4 text-primary-foreground" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default ChatMockup;