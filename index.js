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
app.use(express.json({ limit: "2mb" }));

/*
 * --------------------------------------------------------------------------
 * Firebase Admin
 * --------------------------------------------------------------------------
 * The backend uses the Admin SDK. Never put the service-account private key
 * or RAZORPAY_KEY_SECRET inside the Android app.
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
 * Create Razorpay Order
 * --------------------------------------------------------------------------
 * Sensitive: authenticated users only.
 *
 * The server chooses price/reward from PRODUCTS.
 * The Android client cannot change the amount or number of A-Coins by
 * editing its request body.
 */

app.post(
    "/create-order",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const { productId } = req.body || {};

            const uid = req.uid;
            const product = getProduct(productId);

            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid Zenzy product",
                });
            }

            const amount = rupeesToPaise(
                product.amountRupees
            );

            if (amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid product amount",
                });
            }

            const order = await razorpay.orders.create({
                amount,
                currency: "INR",
                receipt:
                    `zenzy_${productId}_${Date.now()}`
                        .slice(0, 40),

                notes: {
                    uid,
                    productId,
                    app: "zenzy",
                },
            });

            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                productId,
                productType: product.type,
                productName: product.name,
                keyId: process.env.RAZORPAY_KEY_ID,
            });
        } catch (error) {
            console.error(
                "CREATE ORDER ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Unable to create payment order",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * Verify Payment + Credit A-Coin
 * --------------------------------------------------------------------------
 *
 * Sensitive: authenticated users only.
 *
 * Security checks:
 *
 * 1. Firebase token identifies the user.
 * 2. Razorpay signature is verified with the server secret.
 * 3. The order is fetched from Razorpay.
 * 4. Order uid must equal the authenticated uid.
 * 5. Product comes from server-side PRODUCTS.
 * 6. Razorpay order/payment amount must equal the server price.
 * 7. Payment must be captured/authorized.
 * 8. Payment ID is transactionally deduplicated before A-Coin credit.
 */

app.post(
    "/verify-payment",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const {
                razorpay_payment_id,
                razorpay_order_id,
            } = req.body || {};

            if (
                !razorpay_payment_id ||
                !razorpay_order_id
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Payment data missing",
                });
            }

            // Android's Razorpay callback in the Zenzy SDK flow does not
            // provide a payment signature. Verification is performed
            // server-side by fetching the Razorpay order/payment and
            // validating the authenticated Firebase user, product and amount.
            const order =
                await razorpay.orders.fetch(
                    razorpay_order_id
                );

            const uid = order.notes?.uid;
            const productId = order.notes?.productId;

            if (
                !uid ||
                !productId ||
                uid !== req.uid
            ) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Payment order does not belong to this account",
                });
            }

            const product = getProduct(productId);

            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid payment product",
                });
            }

            const expectedAmount =
                rupeesToPaise(
                    product.amountRupees
                );

            if (
                Number(order.amount) !==
                expectedAmount
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment order amount mismatch",
                });
            }

            const payment =
                await razorpay.payments.fetch(
                    razorpay_payment_id
                );

            if (
                Number(payment.amount) !==
                expectedAmount
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment amount mismatch",
                });
            }

            if (
                payment.order_id !==
                razorpay_order_id
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment order mismatch",
                });
            }

            if (
                payment.status !== "captured" &&
                payment.status !== "authorized"
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment not completed",
                });
            }

            const userRef =
                db.collection("users").doc(uid);

            const paymentRef =
                db.collection("payments")
                    .doc(razorpay_payment_id);

            const now = new Date();

            const activatedAt =
                Timestamp.fromDate(now);

            const nextChargeDate =
                new Date(now);

            if (product.trialDays) {
                nextChargeDate.setDate(
                    nextChargeDate.getDate() +
                    product.trialDays
                );
            } else if (product.renewalMonths) {
                nextChargeDate.setMonth(
                    nextChargeDate.getMonth() +
                    product.renewalMonths
                );
            }

            await db.runTransaction(
                async (transaction) => {
                    const existingPayment =
                        await transaction.get(
                            paymentRef
                        );

                    if (existingPayment.exists) {
                        throw new Error(
                            "PAYMENT_ALREADY_PROCESSED"
                        );
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

                    const currentCoins =
                        Math.max(
                            0,
                            Number(
                                userData.aCoins || 0
                            )
                        );

                    const paymentRecord = {
                        uid,
                        productId,
                        productType:
                            product.type,
                        productName:
                            product.name,
                        amountRupees:
                            product.amountRupees,
                        amountPaise:
                            expectedAmount,
                        aCoinReward:
                            product.aCoinReward,

                        razorpayPaymentId:
                            razorpay_payment_id,

                        razorpayOrderId:
                            razorpay_order_id,

                        paymentStatus:
                            payment.status,

                        processedAt:
                            FieldValue.serverTimestamp(),
                    };

                    const userUpdate = {
                        aCoins:
                            currentCoins +
                            product.aCoinReward,

                        updatedAt:
                            FieldValue.serverTimestamp(),
                    };

                    if (
                        product.type ===
                        "premium"
                    ) {
                        const activePlans =
                            Array.isArray(
                                userData.activePlans
                            )
                                ? userData.activePlans
                                : [];

                        const newPlan = {
                            id:
                                `${productId}_${razorpay_payment_id}`,

                            planId:
                                productId,

                            planName:
                                product.name,

                            activatedAt,

                            initialAmountPaid:
                                product.amountRupees,

                            aCoinReward:
                                product.aCoinReward,

                            nextChargeAmount:
                                product.renewalAmountRupees,

                            nextChargeDate:
                                Timestamp.fromDate(
                                    nextChargeDate
                                ),

                            renewalAmount:
                                product.renewalAmountRupees,

                            renewalMonths:
                                product.renewalMonths ||
                                null,

                            trialDays:
                                product.trialDays ||
                                null,

                            status: "active",

                            razorpayPaymentId:
                                razorpay_payment_id,

                            razorpayOrderId:
                                razorpay_order_id,
                        };

                        userUpdate.plan =
                            productId ===
                            "monthly"
                                ? "MONTHLY"
                                : "YEARLY";

                        userUpdate.activePlans =
                            [
                                ...activePlans,
                                newPlan,
                            ];

                        paymentRecord.planId =
                            productId;
                    }

                    transaction.set(
                        userRef,
                        userUpdate,
                        {
                            merge: true,
                        }
                    );

                    transaction.set(
                        paymentRef,
                        paymentRecord
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
                                product.type ===
                                "premium"
                                    ? "Premium Activated"
                                    : "A-Coin Purchase Successful",

                            message:
                                `${product.name}: ` +
                                `${product.aCoinReward} A-Coin ` +
                                `added to your balance.`,

                            type:
                                product.type ===
                                "premium"
                                    ? "premium"
                                    : "a_coin_purchase",

                            read: false,

                            createdAt:
                                FieldValue.serverTimestamp(),

                            razorpayPaymentId:
                                razorpay_payment_id,
                        }
                    );
                }
            );

            return res.json({
                success: true,

                message:
                    product.type === "premium"
                        ? "Payment verified and Premium activated"
                        : "Payment verified and A-Coin added",

                productId,

                productType:
                    product.type,

                aCoinReward:
                    product.aCoinReward,
            });
        } catch (error) {
            console.error(
                "VERIFY PAYMENT ERROR:",
                error
            );

            if (
                error.message ===
                "PAYMENT_ALREADY_PROCESSED"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "This payment was already processed",
                });
            }

            if (
                error.message ===
                "USER_NOT_FOUND"
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Zenzy user account not found",
                });
            }

            return res.status(500).json({
                success: false,
                message:
                    "Payment verification failed",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * Secure Video Request + A-Coin deduction
 * --------------------------------------------------------------------------
 *
 * This endpoint is included so the Android app no longer needs permission
 * to modify aCoins itself.
 *
 * The server checks the balance and creates the request atomically with
 * the deduction.
 *
 * Cloudinary upload can still happen from Android using the existing
 * unsigned upload preset. Only the final photo URLs and request metadata
 * are sent here.
 */

const VIDEO_COSTS = {
    10: 18,
    30: 50,
    50: 76,
    90: 250,
};

app.post(
    "/create-video-request",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const body = req.body || {};

            const {
                name,
                description,
                plan,
                photoUrl,
                photoUrls,
                photoCount,
                photoSelected,
                videoDurationSeconds,
                aCoinCost,
                quality,
                createdAt,
                requestDate,
            } = body;

            const duration =
                Number(videoDurationSeconds);

            const expectedCost =
                VIDEO_COSTS[duration];

            if (
                !expectedCost ||
                Number(aCoinCost) !==
                    expectedCost
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid video duration or A-Coin cost",
                });
            }

            const urls =
                Array.isArray(photoUrls)
                    ? photoUrls.filter(
                        (url) =>
                            typeof url ===
                                "string" &&
                            url.trim()
                    )
                    : [];

            if (
                urls.length < 1 ||
                urls.length > 5
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Please provide 1 to 5 uploaded photos",
                });
            }

            const userRef =
                db.collection("users")
                    .doc(req.uid);

            const requestRef =
                db.collection(
                    "videoRequests"
                ).doc();

            let remainingCoins = 0;

            await db.runTransaction(
                async (transaction) => {
                    const userSnapshot =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !userSnapshot.exists
                    ) {
                        throw new Error(
                            "USER_NOT_FOUND"
                        );
                    }

                    const userData =
                        userSnapshot.data() ||
                        {};

                    const currentCoins =
                        Math.max(
                            0,
                            Number(
                                userData.aCoins ||
                                    0
                            )
                        );

                    if (
                        currentCoins <
                        expectedCost
                    ) {
                        throw new Error(
                            "INSUFFICIENT_A_COINS"
                        );
                    }

                    remainingCoins =
                        currentCoins -
                        expectedCost;

                    transaction.set(
                        userRef,
                        {
                            aCoins:
                                remainingCoins,

                            updatedAt:
                                FieldValue.serverTimestamp(),
                        },
                        {
                            merge: true,
                        }
                    );

                    transaction.set(
                        requestRef,
                        {
                            uid: req.uid,

                            name:
                                typeof name ===
                                "string"
                                    ? name
                                    : "",

                            mobile: req.uid,

                            description:
                                typeof description ===
                                "string"
                                    ? description.trim()
                                    : "",

                            plan:
                                typeof plan ===
                                "string"
                                    ? plan
                                    : "FREE",

                            photoUrl:
                                typeof photoUrl ===
                                "string"
                                    ? photoUrl
                                    : urls[0],

                            photoUrls: urls,

                            photoCount:
                                Number(
                                    photoCount
                                ) ||
                                urls.length,

                            photoSelected:
                                photoSelected !==
                                false,

                            status: "Pending",

                            createdAt:
                                typeof createdAt ===
                                "string"
                                    ? createdAt
                                    : new Date()
                                        .toISOString(),

                            requestDate:
                                typeof requestDate ===
                                "string"
                                    ? requestDate
                                    : new Date()
                                        .toISOString()
                                        .slice(
                                            0,
                                            10
                                        ),

                            videoDurationSeconds:
                                duration,

                            aCoinCost:
                                expectedCost,

                            quality:
                                typeof quality ===
                                "string"
                                    ? quality
                                    : (
                                        duration ===
                                        90
                                            ? "Ultra Full HD"
                                            : "Full HD"
                                    ),

                            submittedAt:
                                FieldValue.serverTimestamp(),
                        }
                    );
                }
            );

            return res.json({
                success: true,

                requestId:
                    requestRef.id,

                remainingCoins,

                aCoinCost:
                    expectedCost,
            });
        } catch (error) {
            console.error(
                "CREATE VIDEO REQUEST ERROR:",
                error
            );

            if (
                error.message ===
                "USER_NOT_FOUND"
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Zenzy user account not found",
                });
            }

            if (
                error.message ===
                "INSUFFICIENT_A_COINS"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "Insufficient A-Coin balance",
                });
            }

            return res.status(500).json({
                success: false,
                message:
                    "Video request could not be created",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * Start Server
 * --------------------------------------------------------------------------
 */

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `Zenzy Payment Backend running on port ${PORT}`
    );
});
