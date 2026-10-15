CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`confidence` real NOT NULL,
	`source_thread_id` text,
	`source_request_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text,
	`tags` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mem_scope` ON `memories` (`tenant_id`,`user_id`,`kind`,`key`);--> statement-breakpoint
CREATE INDEX `idx_mem_lookup` ON `memories` (`tenant_id`,`user_id`,`kind`,`expires_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`items` text NOT NULL,
	`delivered_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orders_tenant_user` ON `orders` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_policies_tenant` ON `policies` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`price` real NOT NULL,
	`tags` text NOT NULL,
	`stock` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_tenant` ON `products` (`tenant_id`,`category`);--> statement-breakpoint
CREATE TABLE `return_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tenant_idem` ON `return_requests` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_users_tenant` ON `users` (`tenant_id`);