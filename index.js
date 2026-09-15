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
 * The backend uses the Admin SDK. Never put the service-account private key
 * or RAZORPAY_KEY_SECRET inside the Android app.
 */

function getFirebaseCredential() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!raw) {
        throw new Error(
            "FIREBASE_SERVICE_ACCOUNT is missing in Render Environment Variables"
        );
    }

    try {
        const serviceAccount = JSON.parse(raw);

        if (!serviceAccount.project_id) {
            throw new Error(
                "project_id is missing inside FIREBASE_SERVICE_ACCOUNT"
            );
        }

        return {
            credential: cert(serviceAccount),
            projectId: serviceAccount.project_id,
        };
    } catch (error) {
        console.error(
            "FIREBASE CONFIG ERROR:",
            error.message
        );

        throw error;
    }
}

const firebaseConfig = getFirebaseCredential();

initializeApp(firebaseConfig);

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
 * Razorpay amounts are stored in paise when creating orders.
 *
 * Premium follows the pricing already present in the supplied Zenzy UI:
 * Monthly: ₹1 initial payment, 210 A-Coin, then ₹499 renewal.
 * Yearly:  ₹1 initial payment, 1049 A-Coin, then ₹2100 renewal after 1 month.
 *
 * Coin packs:
 * ₹49=40, ₹99=90, ₹199=200, ₹499=550, ₹999=1200.
 */

const PRODUCTS = {
    monthly: {
        type: "premium",
        name: "Monthly Premium",
        amountRupees: 1,
        aCoinReward: 210,
        renewalAmountRupees: 499,
        renewalMonths: 1,
        trialDays: 3,
    },

    yearly: {
        type: "premium",
        name: "Yearly Premium",
        amountRupees: 1,
        aCoinReward: 1049,
        renewalAmountRupees: 2100,
        renewalMonths: 1,
    },

    coin_49: {
        type: "coin_pack",
        name: "Starter A-Coin",
        amountRupees: 49,
        aCoinReward: 40,
    },

    coin_99: {
        type: "coin_pack",
        name: "Boost A-Coin",
        amountRupees: 99,
        aCoinReward: 90,
    },

    coin_199: {
        type: "coin_pack",
        name: "Popular A-Coin",
        amountRupees: 199,
        aCoinReward: 200,
    },

    coin_499: {
        type: "coin_pack",
        name: "Pro A-Coin",
        amountRupees: 499,
        aCoinReward: 550,
    },

    coin_999: {
        type: "coin_pack",
        name: "Ultra A-Coin",
        amountRupees: 999,
        aCoinReward: 1200,
    },
};

/* Backward-compatible names for an older client, but all values now point to
 * Zenzy products instead of the old Brain Battle/RD products. */
PRODUCTS.monthlyPlan = PRODUCTS.monthly;
PRODUCTS.yearlyPlan = PRODUCTS.yearly;

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

        return aa.length === bb.length &&
            crypto.timingSafeEqual(aa, bb);
    } catch (_) {
        return false;
    }
}

/*
 * --------------------------------------------------------------------------
 * Authentication middleware
 * --------------------------------------------------------------------------
 * Android sends the Firebase ID token in:
 *
 * Authorization: Bearer <firebase-id-token>
 *
 * The client is NOT trusted for uid. The uid used by every sensitive
 * operation comes from the verified Firebase token.
 */

async function requireFirebaseUser(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const idToken = header
            .substring("Bearer ".length)
            .trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                message: "Authentication token missing",
            });
        }

        const decoded = await adminAuth.verifyIdToken(idToken);

        req.firebaseUser = decoded;
        req.uid = decoded.uid;

        next();
    } catch (error) {
        console.error(
            "AUTH ERROR:",
            error.message || error
        );

        return res.status(401).json({
            success: false,
            message: "Invalid or expired authentication token",
        });
    }
}

/*
 * --------------------------------------------------------------------------
 * Health Check
 * --------------------------------------------------------------------------
 */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Zenzy Payment Backend is running",
    });
});

/*
 * --------------------------------------------------------------------------
 * Razorpay Subscription Webhook
 * --------------------------------------------------------------------------
 * Razorpay sends subscription lifecycle events and renewal charge events to
 * this endpoint. The raw request body is used for webhook signature checks.
 * Configure this URL in Razorpay Dashboard:
 *   https://YOUR-DOMAIN/razorpay-webhook
 *
 * Recommended events:
 *   subscription.authenticated
 *   subscription.activated
 *   subscription.charged
 *   subscription.pending
 *   subscription.halted
 *   subscription.cancelled
 *   subscription.completed
 */

app.post(
    "/razorpay-webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
        try {
            const webhookSecret =
                process.env.RAZORPAY_WEBHOOK_SECRET || "";

            if (!webhookSecret) {
                console.error("RAZORPAY_WEBHOOK_SECRET is missing");
                return res.status(500).json({
                    success: false,
                    message: "Webhook secret is not configured",
                });
            }

            const signature =
                req.headers["x-razorpay-signature"];

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
                console.error(
                    "RAZORPAY WEBHOOK SIGNATURE MISMATCH"
                );
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook signature",
                });
            }

            let event;

            try {
                event = JSON.parse(req.body.toString("utf8"));
            } catch (error) {
                console.error(
                    "RAZORPAY WEBHOOK JSON ERROR:",
                    error.message
                );
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook JSON",
                });
            }

            const eventName = event.event || "";
            const subscriptionEntity =
                event.payload?.subscription?.entity || null;
            const paymentEntity =
                event.payload?.payment?.entity || null;

            if (!subscriptionEntity?.id) {
                return res.json({
                    success: true,
                    ignored: true,
                    message:
                        "Webhook received without subscription data",
                });
            }

            const subscriptionId = subscriptionEntity.id;
            const subscriptionRef = db
                .collection("subscriptions")
                .doc(subscriptionId);

            const existingSubscription =
                await subscriptionRef.get();

            const existingData = existingSubscription.exists
                ? existingSubscription.data() || {}
                : {};

            const notes =
                subscriptionEntity.notes || {};

            const uid =
                existingData.uid || notes.uid || null;
            const productId =
                existingData.productId || notes.productId || null;

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

            if (!product || product.type !== "premium") {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subscription product",
                });
            }

            const userRef = db
                .collection("users")
                .doc(uid);

            if (eventName === "subscription.charged") {
                const paymentId = paymentEntity?.id;

                if (!paymentId) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Subscription charged webhook has no payment ID",
                    });
                }

                const expectedRenewalAmount =
                    rupeesToPaise(
                        product.renewalAmountRupees
                    );

                if (
                    Number(paymentEntity.amount) !==
                    expectedRenewalAmount
                ) {
                    console.error(
                        "WEBHOOK RENEWAL AMOUNT MISMATCH:",
                        {
                            subscriptionId,
                            paymentId,
                            received: paymentEntity.amount,
                            expected: expectedRenewalAmount,
                        }
                    );
                    return res.status(400).json({
                        success: false,
                        message: "Renewal amount mismatch",
                    });
                }

                const paymentRef = db
                    .collection("payments")
                    .doc(paymentId);

                await db.runTransaction(
                    async (transaction) => {
                        const paymentSnapshot =
                            await transaction.get(
                                paymentRef
                            );

                        if (paymentSnapshot.exists) {
                            return;
                        }

                        const userSnapshot =
                            await transaction.get(
                                userRef
                            );

                        if (!userSnapshot.exists) {
                            throw new Error(
                                "USER_NOT_FOUND"
                            );
                        }

                        const userData =
                            userSnapshot.data() || {};

                        const currentCoins = Math.max(
                            0,
                            Number(
                                userData.aCoins || 0
                            )
                        );

                        const paymentRecord = {
                            uid,
                            productId,
                            productType:
                                "premium_renewal",
                            productName:
                                product.name,
                            amountRupees:
                                product.renewalAmountRupees,
                            amountPaise:
                                expectedRenewalAmount,
                            aCoinReward:
                                product.aCoinReward,
                            razorpayPaymentId:
                                paymentId,
                            razorpaySubscriptionId:
                                subscriptionId,
                            paymentStatus:
                                paymentEntity.status ||
                                "captured",
                            processedAt:
                                FieldValue.serverTimestamp(),
                        };

                        transaction.set(
                            userRef,
                            {
                                aCoins:
                                    currentCoins +
                                    product.aCoinReward,
                                isPremium: true,
                                plan:
                                    productId ===
                                    "monthly"
                                        ? "MONTHLY"
                                        : "YEARLY",
                                updatedAt:
                                    FieldValue.serverTimestamp(),
                            },
                            { merge: true }
                        );

                        transaction.set(
                            paymentRef,
                            paymentRecord
                        );

                        transaction.set(
                            subscriptionRef,
                            {
                                uid,
                                productId,
                                productName:
                                    product.name,
                                razorpaySubscriptionId:
                                    subscriptionId,
                                razorpayPlanId:
                                    subscriptionEntity.plan_id ||
                                    existingData.razorpayPlanId ||
                                    null,
                                status:
                                    subscriptionEntity.status ||
                                    "active",
                                paidCount:
                                    subscriptionEntity.paid_count ??
                                    null,
                                remainingCount:
                                    subscriptionEntity.remaining_count ??
                                    null,
                                lastPaymentId:
                                    paymentId,
                                lastRenewalAmountRupees:
                                    product.renewalAmountRupees,
                                nextChargeDate:
                                    subscriptionEntity.charge_at
                                        ? Timestamp.fromMillis(
                                            Number(
                                                subscriptionEntity.charge_at
                                            ) * 1000
                                        )
                                        : null,
                                currentStart:
                                    subscriptionEntity.current_start
                                        ? Timestamp.fromMillis(
                                            Number(
                                                subscriptionEntity.current_start
                                            ) * 1000
                                        )
                                        : null,
                                currentEnd:
                                    subscriptionEntity.current_end
                                        ? Timestamp.fromMillis(
                                            Number(
                                                subscriptionEntity.current_end
                                            ) * 1000
                                        )
                                        : null,
                                updatedAt:
                                    FieldValue.serverTimestamp(),
                            },
                            { merge: true }
                        );

                        const notificationRef =
                            userRef
                                .collection(
                                    "notifications"
                                )
                                .doc();

                        transaction.set(
                            notificationRef,
                            {
                                title:
                                    "Premium Renewed",
                                message:
                                    `${product.name} renewed for ₹${product.renewalAmountRupees}. ` +
                                    `${product.aCoinReward} A-Coins added.`,
                                type: "premium_renewal",
                                read: false,
                                createdAt:
                                    FieldValue.serverTimestamp(),
                                razorpayPaymentId:
                                    paymentId,
                                razorpaySubscriptionId:
                                    subscriptionId,
                            }
                        );
                    }
                );

                return res.json({
                    success: true,
                    message:
                        "Subscription renewal processed",
                });
            }

            const subscriptionStatus =
                subscriptionEntity.status || null;

            const update = {
                uid,
                productId,
                productName: product.name,
                razorpaySubscriptionId:
                    subscriptionId,
                razorpayPlanId:
                    subscriptionEntity.plan_id ||
                    existingData.razorpayPlanId ||
                    null,
                status:
                    subscriptionStatus,
                customerId:
                    subscriptionEntity.customer_id ||
                    existingData.customerId ||
                    null,
                paidCount:
                    subscriptionEntity.paid_count ??
                    existingData.paidCount ??
                    null,
                remainingCount:
                    subscriptionEntity.remaining_count ??
                    existingData.remainingCount ??
                    null,
                nextChargeDate:
                    subscriptionEntity.charge_at
                        ? Timestamp.fromMillis(
                            Number(
                                subscriptionEntity.charge_at
                            ) * 1000
                        )
                        : null,
                currentStart:
                    subscriptionEntity.current_start
                        ? Timestamp.fromMillis(
                            Number(
                                subscriptionEntity.current_start
                            ) * 1000
                        )
                        : null,
                currentEnd:
                    subscriptionEntity.current_end
                        ? Timestamp.fromMillis(
                            Number(
                                subscriptionEntity.current_end
                            ) * 1000
                        )
                        : null,
                updatedAt:
                    FieldValue.serverTimestamp(),
            };

            if (
                eventName === "subscription.cancelled" ||
                eventName === "subscription.completed" ||
                eventName === "subscription.expired"
            ) {
                update.isPremium = false;
                update.plan = "FREE";
            }

            await subscriptionRef.set(
                update,
                { merge: true }
            );

            if (eventName === "subscription.halted") {
                await userRef.set(
                    {
                        subscriptionStatus: "halted",
                        updatedAt:
                            FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );
            }

            if (
                eventName === "subscription.authenticated" ||
                eventName === "subscription.activated"
            ) {
                await userRef.set(
                    {
                        isPremium: true,
                        plan:
                            productId === "monthly"
                                ? "MONTHLY"
                                : "YEARLY",
                        subscriptionStatus:
                            subscriptionStatus ||
                            eventName,
                        updatedAt:
                            FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );
            }

            return res.json({
                success: true,
                processed: true,
                event: eventName,
            });
        } catch (error) {
            console.error(
                "RAZORPAY WEBHOOK ERROR:",
                error
            );

            if (error.message === "USER_NOT_FOUND") {
                return res.status(404).json({
                    success: false,
                    message:
                        "Zenzy user account not found",
                });
            }

            return res.status(500).json({
                success: false,
                message: "Webhook processing failed",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * Create Razorpay Subscription
 * --------------------------------------------------------------------------
 * Premium products use Razorpay Subscriptions.
 *
 * Monthly:
 *   ₹1 upfront/authentication amount now -> 3-day trial -> ₹499/month.
 *
 * Yearly:
 *   ₹1 upfront/authentication amount now -> 1-month trial -> ₹2100/year.
 *
 * The actual recurring billing amount comes from the Razorpay Plan, not from
 * the Android client. The Android client only receives the subscription_id.
 */

app.post(
    "/create-subscription",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const { productId } = req.body || {};
            const uid = req.uid;
            const product = getProduct(productId);

            if (!product || product.type !== "premium") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid Premium subscription selected",
                });
            }

            const planId =
                getSubscriptionPlanId(productId);

            if (!planId) {
                return res.status(500).json({
                    success: false,
                    message:
                        productId === "monthly"
                            ? "Monthly Razorpay Plan ID is not configured"
                            : "Yearly Razorpay Plan ID is not configured",
                });
            }

            const startAt =
                getSubscriptionStartAt(product);

            const subscription =
                await razorpay.subscriptions.create({
                    plan_id: planId,
                    total_count:
                        productId === "monthly"
                            ? 1200
                            : 30,
                    quantity: 1,
                    customer_notify: true,
                    start_at: startAt,
                    addons: [
                        {
                            item: {
                                name:
                                    `${product.name} Initial Payment`,
                                amount:
                                    rupeesToPaise(
                                        product.amountRupees
                                    ),
                                currency: "INR",
                                description:
                                    "Initial payment and mandate authorisation",
                            },
                        },
                    ],
                    notes: {
                        uid,
                        productId,
                        app: "zenzy",
                    },
                });

            await db
                .collection("subscriptions")
                .doc(subscription.id)
                .set(
                    {
                        uid,
                        productId,
                        productName: product.name,
                        razorpaySubscriptionId:
                            subscription.id,
                        razorpayPlanId: planId,
                        status: subscription.status,
                        trialDays:
                            product.trialDays || null,
                        initialAmountRupees:
                            product.amountRupees,
                        renewalAmountRupees:
                            product.renewalAmountRupees,
                        aCoinReward:
                            product.aCoinReward,
                        startAt:
                            Timestamp.fromMillis(
                                startAt * 1000
                            ),
                        nextChargeDate:
                            Timestamp.fromMillis(
                                startAt * 1000
                            ),
                        createdAt:
                            FieldValue.serverTimestamp(),
                        updatedAt:
                            FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

            return res.json({
                success: true,
                subscriptionId: subscription.id,
                keyId:
                    process.env.RAZORPAY_KEY_ID,
                amount:
                    rupeesToPaise(
                        product.amountRupees
                    ),
                currency: "INR",
                productId,
                productType: product.type,
                productName: product.name,
                trialDays:
                    product.trialDays || null,
                renewalAmount:
                    product.renewalAmountRupees,
                startAt,
            });
        } catch (error) {
            console.error(
                "CREATE SUBSCRIPTION ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to create Premium subscription",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * Verify Razorpay Subscription Authorisation
 * --------------------------------------------------------------------------
 * Razorpay Checkout returns:
 *   razorpay_payment_id
 *   razorpay_subscription_id
 *   razorpay_signature
 *
 * Signature = HMAC-SHA256(payment_id|subscription_id, API secret)
 */

app.post(
    "/verify-subscription",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const {
                razorpay_payment_id,
                razorpay_subscription_id,
                razorpay_signature,
            } = req.body || {};

            if (
                !razorpay_payment_id ||
                !razorpay_subscription_id ||
                !razorpay_signature
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Subscription payment data missing",
                });
            }

            const generatedSignature =
                crypto
                    .createHmac(
                        "sha256",
                        process.env.RAZORPAY_KEY_SECRET
                    )
                    .update(
                        `${razorpay_payment_id}|${razorpay_subscription_id}`
                    )
                    .digest("hex");

            if (
                !safeEqualHex(
                    generatedSignature,
                    razorpay_signature
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid subscription payment signature",
                });
            }

            const subscription =
                await razorpay.subscriptions.fetch(
                    razorpay_subscription_id
                );

            const payment =
                await razorpay.payments.fetch(
                    razorpay_payment_id
                );

            const uid =
                subscription.notes?.uid || null;
            const productId =
                subscription.notes?.productId || null;

            if (!uid || uid !== req.uid) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Subscription does not belong to this account",
                });
            }

            const product = getProduct(productId);

            if (!product || product.type !== "premium") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid Premium subscription product",
                });
            }

            const expectedInitialAmount =
                rupeesToPaise(
                    product.amountRupees
                );

            if (
                Number(payment.amount) !==
                expectedInitialAmount
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Initial subscription amount mismatch",
                });
            }

            if (
                payment.status !== "captured" &&
                payment.status !== "authorized"
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Initial subscription payment is not completed",
                });
            }

            const userRef = db
                .collection("users")
                .doc(uid);
            const paymentRef = db
                .collection("payments")
                .doc(razorpay_payment_id);
            const subscriptionRef = db
                .collection("subscriptions")
                .doc(razorpay_subscription_id);

            const startAt =
                subscription.start_at
                    ? Timestamp.fromMillis(
                        Number(
                            subscription.start_at
                        ) * 1000
                    )
                    : null;

            await db.runTransaction(
                async (transaction) => {
                    const existingPayment =
                        await transaction.get(
                            paymentRef
                        );
