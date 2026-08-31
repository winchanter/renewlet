/**
 * 折叠面板设计系统原语。
 *
 * 架构位置：封装 Radix Collapsible，用于订阅分组视图等需要展开/收起的区块。
 */
import * as React from "react";
import * as CollapsiblePrimitives from "@radix-ui/react-collapsible";

import { cn } from "@/lib/utils";

const Collapsible = CollapsiblePrimitives.Root;

const CollapsibleTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitives.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitives.Trigger>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitives.Trigger
    ref={ref}
    className={cn("focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", className)}
    {...props}
  />
));
CollapsibleTrigger.displayName = CollapsiblePrimitives.Trigger.displayName;

const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitives.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitives.Content>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitives.Content
    ref={ref}
    className={cn("overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)}
    {...props}
  />
));
CollapsibleContent.displayName = CollapsiblePrimitives.Content.displayName;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
