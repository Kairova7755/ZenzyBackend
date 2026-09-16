require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const {
    initializeApp,
    applicationDefault,
    cert,
} = require("firebase-admin/app");

const {
    getAuth,
} = require("firebase-admin/auth");

const {
    getFirestore,
    Timestamp,
    FieldValue,
} = require("firebase-admin/firestore");

const app = express();

app.use(cors());
app.use((req, res, next) => {
    if (req.path === "/razorpay-webhook") {
        return next();
    }
    return express.json({ limit: "2mb" })(req, res, next);
});

/*
 * --------------------------------------------------------------------------
 * Firebase Admin
 * --------------------------------------------------------------------------
 */

function getFirebaseCredential() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (raw) {
        try {
            return cert(JSON.parse(raw));
        } catch (error) {
            console.error(
                "FIREBASE_SERVICE_ACCOUNT JSON ERROR:",
                error.message
            );
            throw new Error(
                "Invalid FIREBASE_SERVICE_ACCOUNT environment variable"
            );
        }
    }

    return applicationDefault();
}

initializeApp({
    credential: getFirebaseCredential(),
});

const db = getFirestore();
const adminAuth = getAuth();

/*
 * --------------------------------------------------------------------------
 * Razorpay
 * --------------------------------------------------------------------------
 */

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn("WARNING: Razorpay environment variables are missing.");
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/*
 * --------------------------------------------------------------------------
 * Zenzy products
 * --------------------------------------------------------------------------
 */

const PRODUCTS = {
    monthly: {
        id: "monthly",
        type: "subscription",
        name: "Monthly Premium",
        amountInPaise: 100, // ₹1 initial payment/upfront authorization
        amountRupees: 1,
        aCoinReward: 650,
        renewalAmountRupees: 499,
        renewalPrice: 499,
        trialDays: 3,
        description: "Monthly Zenzy Subscription",
    },
    yearly: {
        id: "yearly",
        type: "subscription",
        name: "Yearly Premium",
        amountInPaise: 100, // ₹1 initial payment/upfront authorization
        amountRupees: 1,
        aCoinReward: 2800,
        renewalAmountRupees: 2100,
        renewalPrice: 2100,
        trialDays: 30, // 1 month
        description: "Yearly Zenzy Subscription",
    },
    coin_49: {
        id: "coin_49",
        type: "pack",
        name: "Starter A-Coin",
        amountInPaise: 4900, // ₹49
        amountRupees: 49,
        aCoinReward: 30,
        description: "30 A-Coins Pack",
    },
    coin_99: {
        id: "coin_99",
        type: "pack",
        name: "Boost A-Coin",
        amountInPaise: 9900, // ₹99
        amountRupees: 99,
        aCoinReward: 80,
        description: "80 A-Coins Pack",
    },
    coin_199: {
        id: "coin_199",
        type: "pack",
        name: "Popular A-Coin",
        amountInPaise: 21000, // ₹210
        amountRupees: 210,
        aCoinReward: 200,
        description: "200 A-Coins Pack",
    },
    coin_499: {
        id: "coin_499",
        type: "pack",
        name: "Pro A-Coin",
        amountInPaise: 49900, // ₹499
        amountRupees: 499,
        aCoinReward: 550,
        description: "550 A-Coins Pack",
    },
    coin_999: {
        id: "coin_999",
        type: "pack",
        name: "Ultra A-Coin",
        amountInPaise: 99900, // ₹999
        amountRupees: 999,
        aCoinReward: 1200,
        description: "1200 A-Coins Pack",
    },
};

PRODUCTS.monthlyPlan = PRODUCTS.monthly;
PRODUCTS.yearlyPlan = PRODUCTS.yearly;

const VIDEO_COSTS = {
    10: 18,
    30: 50,
    50: 76,
    90: 250,
};

function getProduct(productId) {
    return PRODUCTS[productId] || null;
}

const SUBSCRIPTION_PLAN_IDS = {
    monthly: process.env.RAZORPAY_MONTHLY_PLAN_ID || "",
    yearly: process.env.RAZORPAY_YEARLY_PLAN_ID || "",
};

function getSubscriptionPlanId(productId) {
    return SUBSCRIPTION_PLAN_IDS[productId] || null;
}

function getSubscriptionStartAt(product) {
    const start = new Date();

    if (product.trialDays) {
        start.setDate(start.getDate() + product.trialDays);
    } else if (product.renewalMonths) {
        start.setMonth(start.getMonth() + product.renewalMonths);
    }

    return Math.floor(start.getTime() / 1000);
}

function rupeesToPaise(rupees) {
    return Math.round(Number(rupees) * 100);
}

function safeEqualHex(a, b) {
    try {
        const aa = Buffer.from(String(a), "utf8");
        const bb = Buffer.from(String(b), "utf8");

        return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    } catch (_) {
        return false;
    }
}

/*
 * --------------------------------------------------------------------------
 * Authentication Middleware
 * --------------------------------------------------------------------------
 */

async function requireFirebaseUser(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Missing or invalid token format",
            });
        }

        const idToken = header.substring("Bearer ".length).trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Missing token",
            });
        }

        const decoded = await adminAuth.verifyIdToken(idToken);

        req.firebaseUser = decoded;
        req.user = decoded;
        req.uid = decoded.uid;

        next();
    } catch (error) {
        console.error("AUTH ERROR:", error.message || error);

        return res.status(401).json({
            success: false,
            error: "Unauthorized: Invalid or expired authentication token",
        });
    }
}

/*
 * --------------------------------------------------------------------------
 * Health Check & API Routes
 * --------------------------------------------------------------------------
 */

app.get("/", (req, res) => {
    res.status(200).send("Zenzy Backend is Running");
});

/*
 * --------------------------------------------------------------------------
 * One-Time Coin Pack Order Creation (POST /create-order)
 * --------------------------------------------------------------------------
 */
app.post("/create-order", requireFirebaseUser, async (req, res) => {
    try {
        const { productId } = req.body || {};
        const uid = req.uid;
        const product = getProduct(productId);

        if (!productId || !product) {
            return res.status(400).json({ error: "Invalid product selected" });
        }

        if (product.type === "subscription") {
            return res.status(400).json({
                error: "Subscription products must be created via /create-subscription endpoint",
            });
        }

        const options = {
            amount: product.amountInPaise,
            currency: "INR",
            receipt: `rcpt_${uid.substring(0, 8)}_${Date.now()}`,
            notes: {
                uid: uid,
                productId: product.id,
            },
        };

        const order = await razorpay.orders.create(options);

        return res.status(200).json({
            id: order.id,
            orderId: order.id,
            keyId: process.env.RAZORPAY_KEY_ID,
            productName: product.description || product.name,
            entity: order.entity,
            amount: order.amount,
            amount_paid: order.amount_paid,
            amount_due: order.amount_due,
            currency: order.currency,
            receipt: order.receipt,
            status: order.status,
            attempts: order.attempts,
            notes: order.notes,
            created_at: order.created_at,
        });
    } catch (error) {
        console.error("Create Order Error:", error);
        return res.status(500).json({ error: "Failed to create order" });
    }
});

/*
 * --------------------------------------------------------------------------
 * Razorpay Premium Subscription Creation (POST /create-subscription)
 * --------------------------------------------------------------------------
 */
app.post("/create-subscription", requireFirebaseUser, async (req, res) => {
    try {
        const { productId } = req.body || {};
        const uid = req.uid;

        const product = getProduct(productId);

        // Only Premium subscription products are allowed here.
        if (!productId || !product || product.type !== "subscription") {
            return res.status(400).json({
                success: false,
                error: "Invalid subscription product selected",
            });
        }

        // Get Razorpay Plan ID from environment variables.
        const planId = getSubscriptionPlanId(productId);

        if (!planId) {
            console.error(
                `Missing Razorpay plan ID for subscription product: ${productId}`
            );

            return res.status(500).json({
                success: false,
                error: "Subscription plan configuration missing on server",
            });
        }

        /*
         * start_at = when the actual recurring subscription starts.
         *
         * Monthly:
         *   ₹1 authorization now
         *   3-day trial
         *   ₹499 recurring billing after trial
         *
         * Yearly:
         *   ₹1 authorization now
         *   30-day trial
         *   ₹2100 recurring billing after trial
         */
        const startAt = getSubscriptionStartAt(product);

        /*
         * expire_by controls how long the customer has to complete
         * the authorization transaction.
         *
         * We allow authorization for 7 days from now.
         */
        const expireBy =
            Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

        /*
         * Create the REAL Razorpay Subscription.
         *
         * The ₹1 amount is an upfront authorization amount.
         * The actual recurring amount comes from the Razorpay Plan.
         */
        const subscriptionOptions = {
            plan_id: planId,

            // Keep existing Zenzy billing-cycle configuration.
            total_count:
    productId === "monthly"
        ? Number(process.env.RAZORPAY_MONTHLY_TOTAL_COUNT)
        : Number(process.env.RAZORPAY_YEARLY_TOTAL_COUNT),

            quantity: 1,

            // Actual recurring billing begins after the trial.
            start_at: startAt,

            // Authorization payment deadline.
            expire_by: expireBy,

            customer_notify: true,

            /*
             * ₹1 upfront authorization amount.
             *
             * Razorpay documents addons as the mechanism for
             * collecting an upfront amount during authorization.
             */
            addons: [
                {
                    item: {
                        name: "Zenzy Premium Authorization",
                        amount: product.amountInPaise,
                        currency: "INR",
                    },
                },
            ],

            /*
             * Never trust product/user information from Android later.
             * These notes are attached server-side to the Razorpay
             * subscription and are used during verification/webhooks.
             */
            notes: {
                uid: uid,
                productId: product.id,
            },
        };

        const subscription =
            await razorpay.subscriptions.create(subscriptionOptions);

        if (!subscription || !subscription.id) {
            console.error(
                "Razorpay did not return a valid subscription ID:",
                subscription
            );

            return res.status(502).json({
                success: false,
                error: "Razorpay subscription creation failed",
            });
        }

        console.log(
            "ZENZY SUBSCRIPTION CREATED:",
            JSON.stringify({
                uid,
                productId,
                subscriptionId: subscription.id,
                planId,
                startAt,
                expireBy,
                status: subscription.status,
            })
        );

        return res.status(200).json({
            success: true,

            // Main fields required by Android Checkout.
            subscriptionId: subscription.id,
            keyId: process.env.RAZORPAY_KEY_ID,

            // Useful server-side/client-side information.
            id: subscription.id,
            productId: product.id,
            productName: product.name,
            amount: product.amountInPaise,
            currency: "INR",
            status: subscription.status,

            trialEndsAt: startAt,

            planId: subscription.plan_id || planId,

            notes: subscription.notes || {
                uid,
                productId: product.id,
            },
        });
    } catch (error) {
        console.error(
            "Create Subscription Error:",
            error?.error?.description ||
                error?.message ||
                error
        );

        return res.status(500).json({
            success: false,
            error:
                error?.error?.description ||
                error?.message ||
                "Failed to create Razorpay subscription",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Payment Verification (POST /verify-payment)
 * Handles both one-time orders and Razorpay subscriptions cleanly
 * --------------------------------------------------------------------------
 */
app.post("/verify-payment", requireFirebaseUser, async (req, res) => {
    try {
        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_subscription_id,
            razorpay_signature,
        } = req.body || {};

        const uid = req.uid;

        if (!razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification parameters",
            });
        }

        let isSubscriptionFlow = Boolean(razorpay_subscription_id);
        let productId = null;
        let product = null;

        if (isSubscriptionFlow) {
            // Verify Razorpay Subscription Signature: HMAC_SHA256(payment_id + "|" + subscription_id, secret)
            const expectedSignature = crypto
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
                .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
                .digest("hex");

            if (!safeEqualHex(expectedSignature, razorpay_signature)) {
                console.error("RAZORPAY SUBSCRIPTION SIGNATURE MISMATCH");
                return res.status(400).json({
                    success: false,
                    message: "Subscription payment signature verification failed",
                });
            }

            const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);
            if (!subscription) {
                return res.status(404).json({
                    success: false,
                    message: "Razorpay subscription not found",
                });
            }

            const subUid = subscription.notes?.uid;
            productId = subscription.notes?.productId;

            if (!subUid || subUid !== uid) {
                return res.status(403).json({
                    success: false,
                    message: "Subscription does not belong to this account",
                });
            }

            product = getProduct(productId);
            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subscription product",
                });
            }

            const paymentRef = db.collection("payments").doc(razorpay_payment_id);
            const userRef = db.collection("users").doc(uid);
            const subscriptionRef = db.collection("subscriptions").doc(razorpay_subscription_id);

            const trialEndsTimestamp = Timestamp.fromMillis(
                (subscription.start_at || getSubscriptionStartAt(product)) * 1000
            );

            await db.runTransaction(async (transaction) => {
                const paymentDoc = await transaction.get(paymentRef);
                if (paymentDoc.exists) {
                    throw new Error("PAYMENT_ALREADY_PROCESSED");
                }

                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) {
                    throw new Error("USER_NOT_FOUND");
                }

                const userData = userDoc.data() || {};
                const currentCoins = Math.max(
                    0,
                    Number(userData.aCoins || userData.acoin || 0)
                );

                transaction.set(paymentRef, {
                    paymentId: razorpay_payment_id,
                    subscriptionId: razorpay_subscription_id,
                    uid: uid,
                    productId: productId,
                    amount: product.amountInPaise,
                    type: "subscription_initial",
                    status: "captured",
                    createdAt: FieldValue.serverTimestamp(),
                });

                transaction.update(userRef, {
                    aCoins: currentCoins + product.aCoinReward,
                    acoin: currentCoins + product.aCoinReward,
                    isPremium: true,
                    plan: productId === "monthly" ? "MONTHLY" : "YEARLY",
                    subscriptionType: productId,
                    subscriptionStatus: subscription.status || "authenticated",
                    razorpaySubscriptionId: razorpay_subscription_id,
                    subscriptionStartDate: FieldValue.serverTimestamp(),
                    subscriptionStartAt: FieldValue.serverTimestamp(),
                    trialEndsAt: trialEndsTimestamp,
                    renewalAmount: product.renewalAmountRupees,
                    billingCycle: productId === "monthly" ? "monthly" : "yearly",
                    updatedAt: FieldValue.serverTimestamp(),
                });

                transaction.set(
                    subscriptionRef,
                    {
                        uid: uid,
                        productId: productId,
                        productName: product.name,
                        razorpaySubscriptionId: razorpay_subscription_id,
                        razorpayPlanId: subscription.plan_id,
                        status: subscription.status || "authenticated",
                        trialEndsAt: trialEndsTimestamp,
                        renewalAmountRupees: product.renewalAmountRupees,
                        updatedAt: FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

                const notificationRef = db
                    .collection("users")
                    .doc(uid)
                    .collection("notifications")
                    .doc();

                transaction.set(notificationRef, {
                    title: "Premium Activated",
                    message: `Welcome to Zenzy Premium! You received ${product.aCoinReward} A-Coins for activating ${product.name}.`,
                    type: "payment",
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                });
            });

            return res.status(200).json({
                success: true,
                message: "Subscription verified successfully",
                subscriptionId: razorpay_subscription_id,
                productId: productId,
                aCoinReward: product.aCoinReward,
                aCoinAwarded: product.aCoinReward,
            });
        }

        // Standard Order Flow (Coin Packs)
        if (!razorpay_order_id) {
            return res.status(400).json({
                success: false,
                message: "Missing order ID for standard payment verification",
            });
        }

        const order = await razorpay.orders.fetch(razorpay_order_id);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Razorpay order not found",
            });
        }

        const orderUid = order.notes?.uid;
        productId = order.notes?.productId;

        if (!orderUid || !productId) {
            return res.status(400).json({
                success: false,
                message: "Payment order context is missing",
            });
        }

        if (orderUid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Payment order does not belong to this account",
            });
        }

        product = getProduct(productId);
        if (!product) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment product",
            });
        }

        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${order.id}|${razorpay_payment_id}`)
            .digest("hex");

        if (!safeEqualHex(expectedSignature, razorpay_signature)) {
            console.error("RAZORPAY PAYMENT SIGNATURE MISMATCH");
            return res.status(400).json({
                success: false,
                message: "Payment signature verification failed",
            });
        }

        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Razorpay payment not found",
            });
        }

        if (payment.order_id !== order.id) {
            return res.status(400).json({
                success: false,
                message: "Payment and order mismatch",
            });
        }

        if (payment.status !== "captured" && payment.status !== "authorized") {
            return res.status(400).json({
                success: false,
                message: "Payment not completed",
            });
        }

        if (
            Number(order.amount) !== Number(product.amountInPaise) ||
            Number(payment.amount) !== Number(product.amountInPaise)
        ) {
            return res.status(400).json({
                success: false,
                message: "Payment amount mismatch",
            });
        }

        const paymentRef = db.collection("payments").doc(razorpay_payment_id);
        const userRef = db.collection("users").doc(uid);

        await db.runTransaction(async (transaction) => {
            const paymentDoc = await transaction.get(paymentRef);
            if (paymentDoc.exists) {
                throw new Error("PAYMENT_ALREADY_PROCESSED");
            }

            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("USER_NOT_FOUND");
            }

            const userData = userDoc.data() || {};
            const currentCoins = Math.max(
                0,
                Number(userData.aCoins || userData.acoin || 0)
            );

            transaction.set(paymentRef, {
                paymentId: razorpay_payment_id,
                orderId: order.id,
                uid: uid,
                productId: productId,
                amount: payment.amount,
                status: payment.status,
                createdAt: FieldValue.serverTimestamp(),
            });

            const updateData = {
                aCoins: currentCoins + product.aCoinReward,
                acoin: currentCoins + product.aCoinReward,
                updatedAt: FieldValue.serverTimestamp(),
            };

            transaction.update(userRef, updateData);

            const notificationRef = db
                .collection("users")
                .doc(uid)
                .collection("notifications")
                .doc();

            transaction.set(notificationRef, {
                title: "Payment Successful",
                message: `You received ${product.aCoinReward} A-Coins for purchasing ${product.name || product.description}.`,
                type: "payment",
                createdAt: FieldValue.serverTimestamp(),
                read: false,
            });
        });

        return res.status(200).json({
            success: true,
            message: "Payment verified successfully",
            productId: productId,
            aCoinReward: product.aCoinReward,
            aCoinAwarded: product.aCoinReward,
        });

    } catch (error) {
        console.error("Verify Payment Error:", error);

        if (error.message === "PAYMENT_ALREADY_PROCESSED") {
            return res.status(409).json({
                success: false,
                message: "Payment has already been processed",
            });
        }

        if (error.message === "USER_NOT_FOUND") {
            return res.status(404).json({
                success: false,
                message: "User profile not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to process and verify payment",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Get All Premium Subscriptions (GET /my-subscriptions)
 * --------------------------------------------------------------------------
 */
app.get("/my-subscriptions", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;

        const snapshot = await db
            .collection("subscriptions")
            .where("uid", "==", uid)
            .get();

        const subscriptions = snapshot.docs.map((doc) => {
            const data = doc.data() || {};

            return {
                subscriptionId:
                    data.razorpaySubscriptionId || doc.id,
                productId: data.productId || "",
                productName: data.productName || "",
                status: data.status || "",
                trialEndsAt: data.trialEndsAt || null,
                renewalAmountRupees:
                    data.renewalAmountRupees || null,
                cancelAtCycleEnd:
                    data.cancelAtCycleEnd === true,
                cancellationRequestedAt:
                    data.cancellationRequestedAt || null,
                paidCount:
                    data.paidCount ?? null,
                remainingCount:
                    data.remainingCount ?? null,
                updatedAt:
                    data.updatedAt || null,
            };
        });

        subscriptions.sort((a, b) => {
            const aTime =
                a.updatedAt?.toMillis?.() || 0;
            const bTime =
                b.updatedAt?.toMillis?.() || 0;

            return bTime - aTime;
        });

        return res.status(200).json({
            success: true,
            subscriptions,
        });
    } catch (error) {
        console.error("My Subscriptions Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to load subscriptions",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Cancel Subscription Endpoint (POST /cancel-subscription)
 * --------------------------------------------------------------------------
 */

/*
 * --------------------------------------------------------------------------
 * Cancel One Specific Premium Subscription
 * POST /cancel-subscription
 * --------------------------------------------------------------------------
 */
app.post("/cancel-subscription", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const { subscriptionId } = req.body || {};

        if (!subscriptionId || typeof subscriptionId !== "string") {
            return res.status(400).json({
                success: false,
                message: "Subscription ID is required",
            });
        }

        const subscriptionRef = db
            .collection("subscriptions")
            .doc(subscriptionId);

        const subscriptionDoc = await subscriptionRef.get();

        if (!subscriptionDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "Subscription not found",
            });
        }

        const subscriptionData = subscriptionDoc.data() || {};

        if (subscriptionData.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Subscription does not belong to this account",
            });
        }

        const currentStatus = String(
            subscriptionData.status || ""
        ).toLowerCase();

        if (
            ["cancelled", "completed", "expired"].includes(
                currentStatus
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "This subscription is already inactive",
            });
        }

        let cancelledSubscription;

        try {
            cancelledSubscription =
                await razorpay.subscriptions.cancel(
                    subscriptionId,
                    true
                );
        } catch (rzpError) {
            console.error(
                "Razorpay Cancel Error:",
                rzpError?.error?.description ||
                    rzpError?.message ||
                    rzpError
            );

            return res.status(502).json({
                success: false,
                message:
                    rzpError?.error?.description ||
                    rzpError?.message ||
                    "Razorpay could not cancel this subscription",
            });
        }

        const now = FieldValue.serverTimestamp();

        await subscriptionRef.set(
            {
                status:
                    cancelledSubscription?.status ||
                    "cancelled",
                cancelAtCycleEnd: true,
                cancellationRequestedAt: now,
                updatedAt: now,
            },
            { merge: true }
        );

        return res.status(200).json({
            success: true,
            message:
                "Subscription cancellation scheduled successfully. Your current Premium period remains active and automatic renewal is stopped.",
            subscriptionId,
            productId: subscriptionData.productId || "",
            status:
                cancelledSubscription?.status ||
                "cancelled",
            cancelAtCycleEnd: true,
        });
    } catch (error) {
        console.error(
            "Cancel Subscription Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                error?.message ||
                "Failed to cancel subscription",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Subscription Webhook Endpoint (POST /razorpay-webhook)
 * --------------------------------------------------------------------------
 */

app.post(
    "/razorpay-webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
        try {
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

            if (!webhookSecret) {
                console.error("RAZORPAY_WEBHOOK_SECRET is missing");
                return res.status(500).json({
                    success: false,
                    message: "Webhook secret is not configured",
                });
            }

            const signature = req.headers["x-razorpay-signature"];

            if (!signature || !Buffer.isBuffer(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook request",
                });
            }

            const expectedSignature = crypto
                .createHmac("sha256", webhookSecret)
                .update(req.body)
                .digest("hex");

            if (!safeEqualHex(expectedSignature, signature)) {
                console.error("RAZORPAY WEBHOOK SIGNATURE MISMATCH");
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook signature",
                });
            }

            let event;

            try {
                event = JSON.parse(req.body.toString("utf8"));
            } catch (error) {
                console.error("RAZORPAY WEBHOOK JSON ERROR:", error.message);
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook JSON",
                });
            }

            const eventName = event.event || "";
            const subscriptionEntity = event.payload?.subscription?.entity || null;
            const paymentEntity = event.payload?.payment?.entity || null;

            if (!subscriptionEntity?.id) {
                return res.json({
                    success: true,
                    ignored: true,
                    message: "Webhook received without subscription data",
                });
            }

            const subscriptionId = subscriptionEntity.id;
            const subscriptionRef = db.collection("subscriptions").doc(subscriptionId);

            const existingSubscription = await subscriptionRef.get();
            const existingData = existingSubscription.exists
                ? existingSubscription.data() || {}
                : {};

            const notes = subscriptionEntity.notes || {};
            const uid = existingData.uid || notes.uid || null;
            const productId = existingData.productId || notes.productId || null;

            if (!uid || !productId) {
                console.error(
                    "WEBHOOK SUBSCRIPTION CONTEXT MISSING:",
                    subscriptionId
                );
                return res.status(400).json({
                    success: false,
                    message: "Subscription context missing",
                });
            }

            const product = getProduct(productId);

            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subscription product",
                });
            }

            const userRef = db.collection("users").doc(uid);

            if (eventName === "subscription.charged") {
                const paymentId = paymentEntity?.id;

                if (!paymentId) {
                    return res.status(400).json({
                        success: false,
                        message: "Subscription charged webhook has no payment ID",
                    });
                }

                const expectedRenewalAmount = rupeesToPaise(
                    product.renewalAmountRupees || product.amountRupees
                );

                const paymentRef = db.collection("payments").doc(paymentId);

                await db.runTransaction(async (transaction) => {
                    const paymentSnapshot = await transaction.get(paymentRef);
                    if (paymentSnapshot.exists) {
                        return; // Idempotent check: Payment already recorded
                    }

                    const userSnapshot = await transaction.get(userRef);
                    if (!userSnapshot.exists) {
                        throw new Error("USER_NOT_FOUND");
                    }

                    const userData = userSnapshot.data() || {};
                    const currentCoins = Math.max(
                        0,
                        Number(userData.aCoins || userData.acoin || 0)
                    );

                    const paymentRecord = {
                        uid,
                        productId,
                        productType: "premium_renewal",
                        productName: product.name,
                        amountRupees: product.renewalAmountRupees || product.amountRupees,
                        amountPaise: paymentEntity.amount || expectedRenewalAmount,
                        aCoinReward: product.aCoinReward,
                        razorpayPaymentId: paymentId,
                        razorpaySubscriptionId: subscriptionId,
                        paymentStatus: paymentEntity.status || "captured",
                        processedAt: FieldValue.serverTimestamp(),
                    };

                    transaction.set(
                        userRef,
                        {
                            aCoins: currentCoins + product.aCoinReward,
                            acoin: currentCoins + product.aCoinReward,
                            isPremium: true,
                            plan: productId === "monthly" ? "MONTHLY" : "YEARLY",
                            subscriptionStatus: "active",
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );

                    transaction.set(paymentRef, paymentRecord);

                    transaction.set(
                        subscriptionRef,
                        {
                            uid,
                            productId,
                            productName: product.name,
                            razorpaySubscriptionId: subscriptionId,
                            razorpayPlanId:
                                subscriptionEntity.plan_id ||
                                existingData.razorpayPlanId ||
                                null,
                            status: subscriptionEntity.status || "active",
                            paidCount: subscriptionEntity.paid_count ?? null,
                            remainingCount: subscriptionEntity.remaining_count ?? null,
                            lastPaymentId: paymentId,
                            lastRenewalAmountRupees:
                                product.renewalAmountRupees || product.amountRupees,
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );
                });

                return res.json({
                    success: true,
                    message: "Subscription renewal processed",
                });
            }

            const subscriptionStatus = subscriptionEntity.status || null;

            const update = {
                uid,
                productId,
                productName: product.name,
                razorpaySubscriptionId: subscriptionId,
                status: subscriptionStatus,
                updatedAt: FieldValue.serverTimestamp(),
            };

            if (
    eventName === "subscription.cancelled" ||
    eventName === "subscription.completed" ||
    eventName === "subscription.expired"
) {
    update.status = subscriptionStatus;

    const activeSubscriptionsSnapshot = await db
        .collection("subscriptions")
        .where("uid", "==", uid)
        .get();

    const hasAnotherActiveSubscription =
        activeSubscriptionsSnapshot.docs.some((doc) => {
            if (doc.id === subscriptionId) {
                return false;
            }

            const data = doc.data() || {};
            const status = String(
                data.status || ""
            ).toLowerCase();

            return [
                "active",
                "authenticated",
                "pending",
            ].includes(status);
        });

    if (!hasAnotherActiveSubscription) {
        await userRef.set(
            {
                isPremium: false,
                plan: "FREE",
                subscriptionStatus: subscriptionStatus,
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    }
}

            await subscriptionRef.set(update, { merge: true });

            return res.json({
                success: true,
                processed: true,
                event: eventName,
            });
        } catch (error) {
            console.error("RAZORPAY WEBHOOK ERROR:", error);
            return res.status(500).json({
                success: false,
                message: "Webhook processing failed",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * App Listener
 * --------------------------------------------------------------------------
 */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
