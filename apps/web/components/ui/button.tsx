import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ForwardedRef, ReactNode } from 'react';
import { forwardRef } from 'react';

import { cn } from '@avenlyo/ui';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-background hover:bg-muted',
      },
      size: {
        default: 'h-10 px-4 py-2',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  children?: ReactNode;
}

function Button(
  { asChild = false, className, size, variant, ...props }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component className={cn(buttonVariants({ className, size, variant }))} ref={ref} {...props} />
  );
}

const ForwardedButton = forwardRef<HTMLButtonElement, ButtonProps>(Button);
ForwardedButton.displayName = 'Button';

export { ForwardedButton as Button, buttonVariants };
