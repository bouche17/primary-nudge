import { motion } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const CTA = () => {
  return (
    <section className="py-24 px-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        className="max-w-3xl mx-auto text-center bg-primary rounded-3xl p-12 md:p-16 relative overflow-hidden"
      >
        {/* Decorative circles */}
        <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-primary-foreground/5 -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-32 h-32 rounded-full bg-primary-foreground/5 translate-y-1/2 -translate-x-1/2" />

        <div className="relative z-10">
          <h2 className="text-3xl md:text-4xl font-display font-black text-primary-foreground mb-4">
            Never miss another school event
          </h2>
          <p className="text-primary-foreground/80 mb-8 max-w-lg mx-auto">
            Join thousands of UK parents who start their day knowing exactly what's happening at school.
          </p>
          <Button
            size="lg"
            className="bg-card text-foreground hover:bg-card/90 font-display font-bold text-base px-8 py-6 rounded-full shadow-lg"
          >
            <MessageCircle className="w-5 h-5 mr-2" />
            Start on WhatsApp
          </Button>
          <p className="text-primary-foreground/60 text-sm mt-4">Free to use · No app to download · Takes 30 seconds</p>
        </div>
      </motion.div>
    </section>
  );
};

export default CTA;
