import { motion } from "framer-motion";
import { CalendarDays, Shirt, UtensilsCrossed, BookOpen, Bell, Clock } from "lucide-react";

const features = [
  {
    icon: CalendarDays,
    title: "School Events",
    description: "Sports days, parents' evenings, assemblies — never miss a date again.",
  },
  {
    icon: Shirt,
    title: "Non-Uniform Days",
    description: "Get reminded about mufti days, World Book Day costumes, and charity events.",
  },
  {
    icon: UtensilsCrossed,
    title: "Dinner Money",
    description: "Timely nudges before payment deadlines so you're never caught out.",
  },
  {
    icon: BookOpen,
    title: "Homework & Reading",
    description: "Gentle prompts to check reading logs and hand in homework on time.",
  },
  {
    icon: Bell,
    title: "Smart Reminders",
    description: "Morning and evening reminders timed to your schedule, not ours.",
  },
  {
    icon: Clock,
    title: "Term Dates",
    description: "Half terms, INSET days, and holiday dates — all in one place.",
  },
];

const Features = () => {
  return (
    <section className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-4 py-1.5 rounded-full bg-secondary text-secondary-foreground text-sm font-semibold mb-4">
            Features
          </span>
          <h2 className="text-3xl md:text-4xl font-display font-black text-foreground">
            Everything a busy parent needs
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            SchoolRemind keeps track of all the things the school newsletter buries on page 3.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="group bg-card rounded-2xl p-6 border border-border hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300"
            >
              <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4 group-hover:bg-primary group-hover:text-primary-foreground transition-colors duration-300">
                <feature.icon className="w-6 h-6 text-secondary-foreground group-hover:text-primary-foreground transition-colors duration-300" />
              </div>
              <h3 className="font-display font-bold text-lg text-foreground mb-2">{feature.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
