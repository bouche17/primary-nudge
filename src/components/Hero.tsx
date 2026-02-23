import { motion } from "framer-motion";
import { Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import ChatMockup from "./ChatMockup";

const Hero = () => {
  return (
    <section className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-[var(--hero-gradient)]" />

      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-8 pb-20">
        {/* Nav */}
        <nav className="flex items-center justify-between mb-16">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="font-heading font-black text-xl text-foreground">Monty</span>
          </div>
          <Link to="/signup">
            <Button variant="outline" className="rounded-full font-cta font-semibold">
              Get Started
            </Button>
          </Link>
        </nav>

        {/* Hero content */}
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}>

            <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-secondary text-secondary-foreground text-sm font-semibold mb-6">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-soft" />
              AI-powered school reminders
            </span>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-black text-foreground leading-tight mb-6 font-sans">
              Never forget
              <span className="text-primary"> PE kit day</span> again
            </h1>
            <p className="text-lg text-muted-foreground mb-8 max-w-lg leading-relaxed">
              Monty is your friendly AI assistant that keeps you on top of everything happening at your child's primary school — via WhatsApp.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link to="/signup">
                <Button
                  size="lg"
                  className="rounded-full font-cta font-bold text-base px-8 py-6">

                  <Sparkles className="w-5 h-5 mr-2" />
                  Get started free
                </Button>
              </Link>
              <Button
                variant="ghost"
                size="lg"
                className="rounded-full font-cta font-semibold text-base px-8 py-6 text-muted-foreground">

                See how it works
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mt-4">
              ✨ Free to use · No app needed · Works with any UK primary school
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="animate-float">

            <ChatMockup />
          </motion.div>
        </div>
      </div>
    </section>);

};

export default Hero;