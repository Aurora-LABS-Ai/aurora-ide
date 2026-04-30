import React from "react";
import type { LucideProps } from "lucide-react";
import clsx from "clsx";

type IconComponent = React.ComponentType<LucideProps>;

interface AppIconProps extends Omit<LucideProps, "size" | "strokeWidth"> {
  icon: IconComponent;
  size?: number;
  strokeWidth?: number;
}

export const AppIcon: React.FC<AppIconProps> = ({
  icon: Icon,
  className,
  size = 16,
  strokeWidth = 1.9,
  ...props
}) => {
  return (
    <Icon
      aria-hidden="true"
      className={clsx("shrink-0", className)}
      size={size}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
};
