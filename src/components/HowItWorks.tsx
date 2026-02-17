import { motion } from "framer-motion";
import { MessageSquare, School, BellRing } from "lucide-react";

const steps = [
  {
    icon: MessageSquare,
    step: "1",
    title: "Say hello to Monty",
    description: "Add Monty to your WhatsApp contacts and send a quick hello to get started.",
  },
  {
    icon: School,
    step: "2",
    title: "Tell us your school",
    description: "Share your child's school and year group. We'll pull in all the key dates and events.",
  },
  {
    icon: BellRing,
    step: "3",
    title: "Get timely reminders",
    description: "Receive friendly WhatsApp messages before important events, deadlines, and dates.",
  },
];

const HowItWorks = () => {
  return (
    <section className="py-24 px-6 bg-secondary/50">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold mb-4">
            How it works
          </span>
          <h2 className="text-3xl md:text-4xl font-display font-black text-foreground">
            Up and running in 30 seconds
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8">
          {steps.map((step, i) => (
            <motion.div
              key={step.step}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15 }}
              className="text-center"
            >
              <div className="relative mx-auto w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mb-5">
                <step.icon className="w-7 h-7 text-primary-foreground" />
                <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-accent text-accent-foreground text-xs font-bold flex items-center justify-center font-display">
                  {step.step}
                </span>
              </div>
              <h3 className="font-display font-bold text-lg text-foreground mb-2">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
