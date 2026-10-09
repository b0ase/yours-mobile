import { InputHTMLAttributes, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { motion, useAnimation } from 'framer-motion';
import { Theme } from '../theme.types';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  theme: Theme;
  shake?: string;
};

const shakeKeyframes = {
  x: [0, -4, 4, -4, 4, -2, 2, -1, 1, 0],
  transition: { duration: 0.5, ease: 'easeInOut' as const },
};

export const Input = (props: InputProps) => {
  const { shake = 'false', theme, className, style, ...allProps } = props;
  const controls = useAnimation();
  // Every password field gets its own show / hide eye (owner, 9 Oct 2026: Restore / Import had none).
  const isPassword = allProps.type === 'password';
  const [show, setShow] = useState(false);

  const preventScroll = (e: React.WheelEvent<HTMLInputElement>) => {
    (e.target as HTMLInputElement).blur();
    e.stopPropagation();
    setTimeout(() => {
      (e.target as HTMLInputElement).focus();
    }, 0);
  };

  if (shake === 'true') {
    controls.start(shakeKeyframes);
  }

  return (
    <motion.div className="flex justify-center w-full" animate={controls}>
      <div className="relative w-[85%] mx-1 my-1 flex">
      <input
        {...allProps}
        type={isPassword && show ? 'text' : allProps.type}
        onWheel={preventScroll}
        className={`w-full h-9 ${isPassword ? 'pl-4 pr-10' : 'px-4'} py-3 rounded-xl border text-sm outline-none transition-all duration-200 [&[type=number]]:[-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        style={{
          backgroundColor: theme.color.global.row,
          borderColor: theme.color.global.gray + '40',
          color: theme.color.global.contrast,
          fontFamily: "'Inter', Arial, Helvetica, sans-serif",
          ...style,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = theme.color.component.primaryButtonLeftGradient + '80';
          e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.color.component.primaryButtonLeftGradient}30`;
          allProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = theme.color.global.gray + '40';
          e.currentTarget.style.boxShadow = 'none';
          allProps.onBlur?.(e);
        }}
      />
      {isPassword && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 bg-transparent border-0 cursor-pointer"
          style={{ color: theme.color.global.gray }}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
      </div>
    </motion.div>
  );
};
