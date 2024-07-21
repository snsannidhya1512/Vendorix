import { z } from "zod";
import { privateProcedure, router } from "./trpc";
import { TRPCError } from "@trpc/server";
import { getPayloadClient } from "../get-payload";
import { stripe } from "../lib/stripe";
import type Stripe from "stripe";

export const paymentRouter = router({
  createSession: privateProcedure
    .input(z.object({ productIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx;
      const { productIds } = input;

      if (productIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No product IDs provided",
        });
      }

      const payload = await getPayloadClient();

      const { docs: products } = await payload.find({
        collection: "products",
        where: {
          id: {
            in: productIds,
          },
        },
      });

      if (products.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No products found",
        });
      }

      const filteredProducts = products.filter(
        (prod): prod is { id: string; priceId?: string } =>
          typeof prod.id === "string" && typeof prod.priceId === "string"
      );

      if (filteredProducts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No valid products with price IDs found",
        });
      }

      const order = await payload.create({
        collection: "orders",
        data: {
          _isPaid: false,
          products: filteredProducts.map((prod) => prod.id) as string[], // Ensure this is a string array
          user: user.id,
        },
      });

      const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] =
        filteredProducts.map((product) => ({
          price: product.priceId!,
          quantity: 1,
        }));

      // Ensure this price ID is valid and replace it if necessary
      line_items.push({
        price: "price_1OCeBwA19umTXGu8s4p2G3aX",
        quantity: 1,
        adjustable_quantity: {
          enabled: false,
        },
      });

      try {
        const stripeSession = await stripe.checkout.sessions.create({
          success_url: `${process.env.NEXT_PUBLIC_SERVER_URL}/thank-you?orderId=${order.id}`,
          cancel_url: `${process.env.NEXT_PUBLIC_SERVER_URL}/cart`,
          payment_method_types: ["card"],
          mode: "payment",
          metadata: {
            userId: user.id,
            orderId: order.id,
          },
          line_items,
        });

        return { url: stripeSession.url };
      } catch (err) {
        console.error("Stripe session creation error:", err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create Stripe session",
        });
      }
    }),

  pollOrderStatus: privateProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const { orderId } = input;

      const payload = await getPayloadClient();

      const { docs: orders } = await payload.find({
        collection: "orders",
        where: {
          id: {
            equals: orderId,
          },
        },
      });

      if (orders.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      const [order] = orders;

      return { isPaid: order._isPaid };
    }),
});
