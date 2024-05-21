const createHttpError = require("http-errors");
const { PrismaClient } = require("@prisma/client");
const { randomUUID } = require("crypto");

const { generateTOTP, validateTOTP, generateOTPEmail } = require("../utils/otp");
const { secretCompare, secretHash } = require("../utils/hashSalt");
const {generateJWT} = require("../utils/jwtGenerate")

const {authorizationUrl, oauth2Client} = require("../lib/googleOauth2");
const { google } = require("googleapis");

const prisma = new PrismaClient();

const handleRegister = async (req, res, next) => {
    try {
        const { name, phoneNumber, password, email } = req.body;

        const hashedPassword = secretHash(password);
        const OTPToken = generateTOTP();

        try {
            const userauthData = await prisma.user.create({
                data: {
                    id: randomUUID(),
                    name: name,
                    phoneNumber: phoneNumber,
                    role: "BUYER",
                    Auth: {
                        create: {
                            id: randomUUID(),
                            email: email,
                            password: hashedPassword,
                            otpToken: OTPToken,
                            isVerified: false,
                        },
                    },
                },
            });

            const dataUrl = {
                key: userauthData.id,
                data: email,
                secret: secretHash(userauthData.id),
                unique: randomUUID(),
                note: "skyfly1Verification",
            };

            await generateOTPEmail(dataUrl, OTPToken, email, "verified")

            res.status(200).json({
                status: true,
                message:
                    "Verification token has been sent, please check your email",
                data: {
                    name: name,
                    email: email,
                    phoneNumber: phoneNumber,
                    role: userauthData.role,
                },
            });
        } catch (error) {
            console.log(error.message);
            next(
                createHttpError(409, {
                    message: "Email has already been taken",
                })
            );
        }
    } catch (error) {
        next(
            createHttpError(500, {
                message: error.message,
            })
        );
    }
};

const handleLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const userAccount = await prisma.auth.findUnique({
            where: {
                email,
            },
            include: {
                user: true,
            },
        });

        const payload = {
            id: userAccount.user.id,
            name: userAccount.user.name,
            email: userAccount.email,
            phoneNumber: userAccount.user.phoneNumber,
        }

        if (userAccount && secretCompare(password, userAccount.password)) {
            const token = generateJWT(payload)

            res.status(200).json({
                message: "User logged in successfully",
                _token: token,
            });
        }

        !userAccount
            ? next(createHttpError(404, { message: "Email not registered" }))
            : null;
        !secretCompare(password, userAccount.password)
            ? next(createHttpError(401, { message: "Wrong password" }))
            : null;
    } catch (error) {
        next(createHttpError(500, { error: error.message }));
    }
};

const resendOTP = async (req, res, next) => {
    try {
        const { secret, data, key, unique } = req.query;

        if (!secretCompare(key, secret)) {
            return next(
                createHttpError(401, {
                    message: "You does not have an access to be here",
                })
            );
        }

        const foundUser = await prisma.auth.findUnique({
            where: {
                email: data,
            },
            include: {
                user: true,
            },
        });

        if (!foundUser) {
            return next(createHttpError(404, { message: "User is not found" }));
        }

        if (foundUser.isVerified) {
            return next(
                createHttpError(403, {
                    message: "User email has been verified",
                })
            );
        }

        const OTPToken = generateTOTP();

        await prisma.auth.update({
            where: {
                email: data,
            },
            data: {
                otpToken: OTPToken,
            },
        });

        const dataUrl = {
            key,
            data,
            secret: secretHash(key),
            unique: randomUUID(),
            note: "skyfly1ResendOTP",
        };

        await generateOTPEmail(dataUrl, OTPToken, data, "verified")
        // const urlTokenVerification = `http://localhost:2000/api/v1/auth/verified?secret=${
        //     dataUrl.secret
        // }&data=${dataUrl.data}&key=${dataUrl.key}&unique=${
        //     dataUrl.unique + dataUrl.note
        // }`;

        // const html = await nodeMailer.getHtml("verifyOtp.ejs", {
        //     email: data,
        //     OTPToken,
        //     urlTokenVerification,
        // });

        // nodeMailer.sendEmail(
        //     data,
        //     "Re-send Email Activation | SkyFly Team 01 Jago",
        //     html
        // );

        res.status(201).json({
            status: true,
            message: "Verification link has been sent, please check your email",
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const verifyOTP = async (req, res, next) => {
    try {
        const { secret, data, key } = req.query;
        const { otp } = req.body;

        if (!secretCompare(key, secret)) {
            return next(
                createHttpError(401, {
                    message: "You does not have an access to be here",
                })
            );
        }

        const foundUser = await prisma.auth.findUnique({
            where: {
                email: data,
            },
            include: {
                user: true,
            },
        });

        if (!foundUser) {
            return next(createHttpError(404, { message: "User is not found" }));
        }

        if (foundUser.isVerified) {
            return next(
                createHttpError(403, {
                    message: "User email has been verified",
                })
            );
        }

        let delta = validateTOTP(otp);

        // console.log("====================================");
        // console.log(`delta: ${delta}`);
        // console.log(`otp: ${otp}`);
        // console.log(`user otp: ${foundUser.otpToken}`);
        // console.log("====================================");

        if (delta === null || otp != foundUser.otpToken) {
            return next(
                createHttpError(422, { message: "OTP Token is invalid" })
            );
        }

        await prisma.auth.update({
            where: {
                id: foundUser.id,
            },
            data: {
                isVerified: true,
                otpToken: null

            },
        });

        res.status(200).json({
            status: true,
            message: "user email verified successfully",
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const sendResetPassword = async (req, res, next) => {
    try {
        const { email } = req.body;

        const foundUser = await prisma.auth.findUnique({
            where: {
                email,
            },
            include: {
                user: true,
            },
        });

        if (!foundUser) {
            return next(
                createHttpError(404, {
                    message:
                        "User is not found and reset password link is invalid",
                })
            );
        }

        const dataUrl = {
            key: foundUser.id,
            data: foundUser.email,
            secret: secretHash(email),
            unique: randomUUID(),
            note: "skyfly1ResetPassword",
        };

        await generateOTPEmail(dataUrl, null, email, "resetPassword")

        // const urlResetPassword = `http://localhost:2000/api/v1/auth/resetPassword?secret=${
        //     dataUrl.secret
        // }&data=${dataUrl.data}&key=${dataUrl.key}&unique=${
        //     dataUrl.unique + dataUrl.note
        // }`;

        // const html = await nodeMailer.getHtml("emailPasswordReset.ejs", {
        //     email,
        //     urlResetPassword,
        // });

        // nodeMailer.sendEmail(
        //     email,
        //     "Reset Password | SkyFly Team 01 Jago",
        //     html
        // );

        console.log(urlResetPassword)
        res.status(200).json({
            status: true,
            message:
                "Reset password link has been sent, please check your email",
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const resetPassword = async (req, res, next) => {
    try {
        const { secret, data } = req.query;
        const { password } = req.body;
        const hashedPassword = secretHash(password);

        if (!secretCompare(data, secret)) {
            return next(
                createHttpError(401, {
                    message: "You does not have an access to be here",
                })
            );
        }

        const foundUser = await prisma.auth.findUnique({
            where: {
                email: data,
            },
            include: {
                user: true,
            },
        });

        if (!foundUser) {
            return next(createHttpError(404, { message: "User is not found" }));
        }

        await prisma.auth.update({
            where: {
                id: foundUser.id,
            },
            data: {
                password: hashedPassword,
            },
        });

        res.status(200).json({
            status: true,
            message: "user password updated successfully",
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const handleLoginGoogle = async (req, res, next) => {
    try {
        // generate token
        const { code } = req.query
        const { tokens } = await oauth2Client.getToken(code);

        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({
            auth: oauth2Client,
            version: 'v2'
        })
        console.log("sebelum1")

        const {data} = await oauth2.userinfo.get()

        console.log(data)
        if(!data) return next(createHttpError(404, {status: false}))

        console.log(data)
        console.log("sebelum")
        let userAccount = await prisma.Auth.findUnique({
            where: {
                email: data.email
            },
            include: {
                user: true
            }
        })

        console.log("habis find")

        if(!userAccount){
            const hashedPassword = secretHash(data.id);
            console.log("masuk akun kosong")
            const OTPToken = generateTOTP()
            userAccount = await prisma.Auth.create({
                data: {
                    id: randomUUID(),
                        email: data.email,
                        password: hashedPassword,
                        otpToken: OTPToken,
                        isVerified: false,
                        user: {
                            create: {
                                id: randomUUID(),
                                name: data.name,
                                role: "BUYER",
                            }
                        }
                }
            })
        }

        if(!userAccount.isVerified){
            console.log("masuk isVerified")
            const OTPToken = generateTOTP()
            
            const dataUrl = {
                key: userAccount.id,
                data: data.email,
                secret: secretHash(userAccount.id),
                unique: randomUUID(),
                note: "skyfly1Verification",
            };
            // send otp to user email
            const OTPUrl = await generateOTPEmail(dataUrl, OTPToken, data.email, "verified")
            return res.status(200).json({
                status: true,
                OTPUrl
            })
        }

        const payload = {
            name: userAccount.user.name,
            email: userAccount.email,
            phoneNumber: userAccount?.user.phoneNumber
        }

        const token = generateJWT(payload)
 
        res.status(200).json({
            status: true,
            data: payload,
            _token: token
        })

    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
}

const redirectAuthorization = (req, res) => {
    res.redirect(authorizationUrl)
}

// dummy route to check all email

const checkData = async (req, res, next) => {
    try {
        const data = await prisma.Auth.findMany()
        res.status(200).json({
            status: true,
            data
        })
    } catch (error) {
        next(createHttpError(500, {error: error.message}))
    }
}
module.exports = {
    handleRegister,
    handleLogin,
    verifyOTP,
    resendOTP,
    sendResetPassword,
    resetPassword,
    handleLoginGoogle,
    redirectAuthorization,
    checkData
};
