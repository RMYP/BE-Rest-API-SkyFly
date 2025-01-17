const { PrismaClient } = require("@prisma/client");
const {
    calculateFlightDuration,
    sortShortestDuration,
    formatPrice,
} = require("../utils/calculateDuration");
const { formatDate, formatTime, toWib } = require("../utils/formatDate");
const createHttpError = require("http-errors");

const prisma = new PrismaClient();

const getAllFlight = async (req, res, next) => {
    try {
        const {
            departureAirport,
            arrivalAirport,
            departureDate,
            returnDate,
            airlineName,
            adult = 1,
            children = 0,
            baby = 0,
            seatClass,
            minPrice,
            maxPrice,
            facilities,
            hasTransit,
            hasDiscount,
            sort,
        } = req.query;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const take = parseInt(limit);

        let filters = { AND: [] };
        let returnFilters = { AND: [] };

        if (departureAirport) {
            filters.AND.push({
                OR: [
                    {
                        departureAirport: {
                            code: {
                                contains: departureAirport.toUpperCase(),
                                mode: "insensitive",
                            },
                        },
                    },
                    {
                        departureAirport: {
                            city: {
                                contains: departureAirport,
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            });
        }

        if (arrivalAirport) {
            filters.AND.push({
                OR: [
                    {
                        destinationAirport: {
                            code: {
                                contains: arrivalAirport.toUpperCase(),
                                mode: "insensitive",
                            },
                        },
                    },
                    {
                        destinationAirport: {
                            city: {
                                contains: arrivalAirport,
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            });
        }

        if (departureDate) {
            const parsedDepartureDate = new Date(departureDate);
            filters.AND.push({
                departureDate: {
                    gte: new Date(parsedDepartureDate.setHours(0, 0, 0, 0)),
                    lt: new Date(parsedDepartureDate.setHours(23, 59, 59, 999)),
                },
            });
        }

        if (returnDate) {
            const parsedReturnDate = new Date(returnDate);
            returnFilters.AND.push({
                departureDate: {
                    gte: new Date(parsedReturnDate.setHours(0, 0, 0, 0)),
                    lt: new Date(parsedReturnDate.setHours(23, 59, 59, 999)),
                },
            });

            if (departureAirport) {
                returnFilters.AND.push({
                    OR: [
                        {
                            destinationAirport: {
                                code: {
                                    contains: departureAirport.toUpperCase(),
                                    mode: "insensitive",
                                },
                            },
                        },
                        {
                            destinationAirport: {
                                city: {
                                    contains: departureAirport,
                                    mode: "insensitive",
                                },
                            },
                        },
                    ],
                });
            }

            if (arrivalAirport) {
                returnFilters.AND.push({
                    OR: [
                        {
                            departureAirport: {
                                code: {
                                    contains: arrivalAirport.toUpperCase(),
                                    mode: "insensitive",
                                },
                            },
                        },
                        {
                            departureAirport: {
                                city: {
                                    contains: arrivalAirport,
                                    mode: "insensitive",
                                },
                            },
                        },
                    ],
                });
            }
        }

        if (airlineName) {
            const airlineNames = airlineName.split("%20");
            const airlineFilters = airlineNames.map((name) => ({
                OR: [
                    {
                        plane: {
                            name: {
                                contains: name,
                                mode: "insensitive",
                            },
                        },
                    },
                    {
                        plane: {
                            code: {
                                contains: name.toUpperCase(),
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            }));
            filters.AND.push({ OR: airlineFilters });
            returnFilters.AND.push({ OR: airlineFilters });
        }

        if (seatClass) {
            filters.AND.push({
                seats: {
                    some: {
                        type: seatClass.toUpperCase(),
                        status: "AVAILABLE",
                    },
                },
            });
        }

        if (hasTransit && hasTransit === "true") {
            filters.AND.push({ transitAirport: { isNot: null } });
        } else if (hasTransit && hasTransit === "false") {
            filters.AND.push({ transitAirport: null });
        }

        if (hasDiscount && hasDiscount === "true") {
            filters.AND.push({ discount: { not: null } });
        } else if (hasDiscount && hasDiscount === "false") {
            filters.AND.push({ discount: null });
        }

        if (minPrice || maxPrice) {
            if (minPrice) {
                filters.AND.push({ price: { gte: parseFloat(minPrice) } });
            }
            if (maxPrice) {
                filters.AND.push({ price: { lte: parseFloat(maxPrice) } });
            }
        }

        if (facilities) {
            const facilityList = facilities.split("%20");
            facilityList.forEach((facility) => {
                filters.AND.push({ facilities: { contains: facility.trim() } });
            });
        }

        const totalPassengers =
            parseInt(adult) + parseInt(children) + parseInt(baby);
        filters.AND.push({ capacity: { gte: totalPassengers } });
        returnFilters.AND.push({ capacity: { gte: totalPassengers } });

        const sortOptions = {
            "shortest-duration": {
                departureDate: "asc",
                arrivalDate: "asc",
            },
            "earliest-departure": { departureDate: "asc" },
            "latest-departure": { departureDate: "desc" },
            "earliest-arrival": { arrivalDate: "asc" },
            "latest-arrival": { arrivalDate: "desc" },
            "lowest-price": { price: "asc" },
        };

        let orderBy = [];
        let sortedBy = "";

        if (sort) {
            sortedBy = sort;
            if (sort === "shortest-duration") {
                orderBy = [{ departureDate: "asc" }, { arrivalDate: "asc" }];
            } else {
                const orderByOption = sortOptions[sort];
                if (orderByOption) {
                    orderBy.push(orderByOption);
                }
            }
        }

        const seatClasses = ["ECONOMY", "BUSINESS", "FIRST"];

        let priceRanges = {};

        await Promise.all(
            seatClasses.map(async (seatClass) => {
                const result = await prisma.flightSeat.aggregate({
                    _min: {
                        price: true,
                    },
                    _max: {
                        price: true,
                    },
                    where: {
                        type: seatClass,
                        price: {
                            gte: parseFloat(minPrice) || 0,
                            lte:
                                parseFloat(maxPrice) || Number.MAX_SAFE_INTEGER,
                        },
                    },
                });

                if (result && result._min !== null && result._max !== null) {
                    priceRanges[seatClass] = {
                        minPrice: formatPrice(result._min.price),
                        maxPrice: formatPrice(result._max.price),
                    };
                } else {
                    priceRanges[seatClass] = "No flights found";
                }
            })
        );

        const flightsDeparture = await prisma.flight.findMany({
            where: filters,
            skip,
            take,
            orderBy,
            include: {
                departureAirport: true,
                transitAirport: true,
                destinationAirport: true,
                seats: true,
                plane: true,
            },
        });

        const flightsReturn = await prisma.flight.findMany({
            where: returnFilters,
            skip,
            take,
            orderBy,
            include: {
                departureAirport: true,
                transitAirport: true,
                destinationAirport: true,
                seats: true,
                plane: true,
            },
        });

        const totalDeparture = await prisma.flight.count({ where: filters });
        const total = totalDeparture;
        const totalPages = Math.ceil(total / take);
        const currentPage = parseInt(page);

        const formattedFlightsDeparture = flightsDeparture.map((flight) => {
            const duration = calculateFlightDuration(
                flight.departureDate,
                flight.arrivalDate
            );
            let classInfo = {};

            if (seatClass) {
                const seat = flight.seats.find(
                    (seat) => seat.type === seatClass.toUpperCase()
                );
                classInfo = {
                    seatClass: seat ? seat.type : seatClass.toUpperCase(),
                    seatPrice: seat ? seat.price : null,
                };
            } else {
                classInfo = ["ECONOMY", "BUSINESS", "FIRST"].map((type) => {
                    const seat = flight.seats.find(
                        (seat) => seat.type === type
                    );
                    return {
                        seatClass: type,
                        seatPrice: seat ? seat.price : null,
                    };
                });
            }

            return {
                id: flight.id,
                planeId: flight.planeId,
                plane: {
                    name: flight.plane.name,
                    code: flight.plane.code,
                    image: flight.plane.image,
                    terminal: flight.plane.terminal,
                },
                departureDate: formatDate(flight.departureDate),
                departureTime: formatTime(flight.departureDate),
                code: flight.code,
                departureAirport: {
                    id: flight.departureAirport.id,
                    name: flight.departureAirport.name,
                    code: flight.departureAirport.code,
                    country: flight.departureAirport.country,
                    city: flight.departureAirport.city,
                    continent: flight.departureAirport.continent,
                    image: flight.departureAirport.image,
                },
                transit: flight.transitAirport
                    ? {
                          status: true,
                          arrivalDate: formatDate(flight.transitArrivalDate),
                          arrivalTime: formatTime(flight.transitArrivalDate),
                          departureDate: formatDate(
                              flight.transitDepartureDate
                          ),
                          departureTime: formatTime(flight.transitArrivalDate),
                          transitAirport: {
                              id: flight.transitAirport.id,
                              name: flight.transitAirport.name,
                              code: flight.transitAirport.code,
                              country: flight.transitAirport.country,
                              city: flight.transitAirport.city,
                              continent: flight.transitAirport.continent,
                              image: flight.transitAirport.image,
                          },
                      }
                    : {
                          status: false,
                      },
                arrivalDate: formatDate(flight.arrivalDate),
                arrivalTime: formatTime(flight.arrivalDate),
                destinationAirport: {
                    id: flight.destinationAirport.id,
                    name: flight.destinationAirport.name,
                    code: flight.destinationAirport.code,
                    country: flight.destinationAirport.country,
                    city: flight.destinationAirport.city,
                    continent: flight.destinationAirport.continent,
                    image: flight.destinationAirport.image,
                },
                capacity: flight.capacity,
                discount: flight.discount,
                price: flight.price,
                facilities: flight.facilities,
                duration: duration,
                classInfo: classInfo,
            };
        });

        const formattedFlightsReturn = flightsReturn.map((flight) => {
            let classInfo = {};

            if (seatClass) {
                const seat = flight.seats.find(
                    (seat) => seat.type === seatClass.toUpperCase()
                );
                classInfo = {
                    seatClass: seat ? seat.type : seatClass.toUpperCase(),
                    seatPrice: seat ? seat.price : null,
                };
            } else {
                classInfo = ["ECONOMY", "BUSINESS", "FIRST"].map((type) => {
                    const seat = flight.seats.find(
                        (seat) => seat.type === type
                    );
                    return {
                        seatClass: type,
                        seatPrice: seat ? seat.price : null,
                    };
                });
            }

            const duration = calculateFlightDuration(
                flight.departureDate,
                flight.arrivalDate
            );
            return {
                id: flight.id,
                planeId: flight.planeId,
                plane: {
                    name: flight.plane.name,
                    code: flight.plane.code,
                    terminal: flight.plane.terminal,
                    image: flight.plane.image,
                    terminal: flight.plane.terminal,
                },
                departureDate: formatDate(flight.departureDate),
                departureTime: formatTime(flight.departureDate),
                code: flight.code,
                departureAirport: {
                    id: flight.departureAirport.id,
                    name: flight.departureAirport.name,
                    code: flight.departureAirport.code,
                    country: flight.departureAirport.country,
                    city: flight.departureAirport.city,
                    continent: flight.departureAirport.continent,
                    image: flight.departureAirport.image,
                },
                transit: flight.transitAirport
                    ? {
                          arrivalDate: formatDate(flight.transitArrivalDate),
                          arrivalTime: formatTime(flight.transitArrivalDate),
                          departureDate: formatDate(
                              flight.transitDepartureDate
                          ),
                          departureTime: formatTime(flight.transitArrivalDate),
                          transitAirport: {
                              id: flight.transitAirport.id,
                              name: flight.transitAirport.name,
                              code: flight.transitAirport.code,
                              country: flight.transitAirport.country,
                              city: flight.transitAirport.city,
                              continent: flight.transitAirport.continent,
                              image: flight.transitAirport.image,
                          },
                          status: true,
                      }
                    : {
                          status: false,
                      },
                arrivalDate: formatDate(flight.arrivalDate),
                arrivalTime: formatTime(flight.arrivalDate),
                destinationAirport: {
                    id: flight.destinationAirport.id,
                    name: flight.destinationAirport.name,
                    code: flight.destinationAirport.code,
                    country: flight.destinationAirport.country,
                    city: flight.destinationAirport.city,
                    continent: flight.destinationAirport.continent,
                    image: flight.destinationAirport.image,
                },
                capacity: flight.capacity,
                discount: flight.discount,
                price: flight.price,
                facilities: flight.facilities,
                duration: duration,
                classInfo: classInfo,
            };
        });

        if (sort === "earliest-departure") {
            formattedFlightsDeparture.sort((a, b) => {
                return new Date(a.departureDate) - new Date(b.departureDate);
            });
            formattedFlightsReturn.sort((a, b) => {
                return new Date(a.departureDate) - new Date(b.departureDate);
            });
        } else if (sort === "latest-departure") {
            formattedFlightsDeparture.sort((a, b) => {
                return new Date(b.departureDate) - new Date(a.departureDate);
            });
            formattedFlightsReturn.sort((a, b) => {
                return new Date(b.departureDate) - new Date(a.departureDate);
            });
        }

        if (sort === "earliest-arrival") {
            formattedFlightsDeparture.sort((a, b) => {
                return new Date(a.arrivalDate) - new Date(b.arrivalDate);
            });
            formattedFlightsReturn.sort((a, b) => {
                return new Date(a.arrivalDate) - new Date(b.arrivalDate);
            });
        } else if (sort === "latest-arrival") {
            formattedFlightsDeparture.sort((a, b) => {
                return new Date(b.arrivalDate) - new Date(a.arrivalDate);
            });
            formattedFlightsReturn.sort((a, b) => {
                return new Date(b.arrivalDate) - new Date(a.arrivalDate);
            });
        }

        if (sort === "shortest-duration") {
            formattedFlightsDeparture.sort((a, b) => {
                const durationA = sortShortestDuration(a.duration);
                const durationB = sortShortestDuration(b.duration);
                return durationA - durationB;
            });
            formattedFlightsReturn.sort((a, b) => {
                const durationA = sortShortestDuration(a.duration);
                const durationB = sortShortestDuration(b.duration);
                return durationA - durationB;
            });
        }

        res.status(200).json({
            status: true,
            message: "All flight data retrieved successfully",
            totalItems: total,
            sortedBy,
            pagination: {
                totalPages: totalPages,
                currentPage: currentPage,
                pageItems:
                    formattedFlightsDeparture.length +
                    formattedFlightsReturn.length,
                nextPage: currentPage < totalPages ? currentPage + 1 : null,
                prevPage: currentPage > 1 ? currentPage - 1 : null,
            },
            priceRanges,
            data: formattedFlightsDeparture,
            returnFlights: returnDate ? formattedFlightsReturn : null,
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const getFlightById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { seatClass } = req.query;

        const flight = await prisma.flight.findUnique({
            where: { id },
            include: {
                departureAirport: true,
                transitAirport: true,
                destinationAirport: true,
                seats: true,
                plane: true,
            },
        });

        if (!flight) {
            return res.status(404).json({ message: "Flight not found" });
        }

        const formatFlight = (flight) => {
            const duration = calculateFlightDuration(
                flight.departureDate,
                flight.arrivalDate
            );
            let classInfo = {};

            if (seatClass) {
                const seat = flight.seats.find(
                    (seat) => seat.type === seatClass.toUpperCase()
                );
                classInfo = [
                    {
                        seatClass: seatClass.toUpperCase(),
                        seatPrice: seat ? seat.price : null,
                    },
                ];
            } else {
                classInfo = ["ECONOMY", "BUSINESS", "FIRST"].map((type) => {
                    const seat = flight.seats.find(
                        (seat) => seat.type === type
                    );
                    return {
                        seatClass: type,
                        seatPrice: seat ? seat.price : null,
                    };
                });
            }

            return {
                id: flight.id,
                planeId: flight.planeId,
                plane: {
                    name: flight.plane.name,
                    code: flight.plane.code,
                    terminal: flight.plane.terminal,
                    image: flight.plane.image,
                },
                departureDate: formatDate(flight.departureDate),
                departureTime: formatTime(flight.departureDate),
                code: flight.code,
                departureAirport: {
                    id: flight.departureAirport.id,
                    name: flight.departureAirport.name,
                    code: flight.departureAirport.code,
                    country: flight.departureAirport.country,
                    city: flight.departureAirport.city,
                    continent: flight.departureAirport.continent,
                    image: flight.departureAirport.image,
                },
                transit: flight.transitAirport
                    ? {
                          status: true,
                          arrivalDate: formatDate(flight.transitArrivalDate),
                          arrivalTime: formatTime(flight.transitArrivalDate),
                          departureDate: formatDate(
                              flight.transitDepartureDate
                          ),
                          departureTime: formatTime(
                              flight.transitDepartureDate
                          ),
                          transitAirport: {
                              id: flight.transitAirport.id,
                              name: flight.transitAirport.name,
                              code: flight.transitAirport.code,
                              country: flight.transitAirport.country,
                              city: flight.transitAirport.city,
                              continent: flight.transitAirport.continent,
                              image: flight.transitAirport.image,
                          },
                      }
                    : {
                          status: false,
                      },
                arrivalDate: formatDate(flight.arrivalDate),
                arrivalTime: formatTime(flight.arrivalDate),
                destinationAirport: {
                    id: flight.destinationAirport.id,
                    name: flight.destinationAirport.name,
                    code: flight.destinationAirport.code,
                    country: flight.destinationAirport.country,
                    city: flight.destinationAirport.city,
                    continent: flight.destinationAirport.continent,
                    image: flight.destinationAirport.image,
                },
                capacity: flight.capacity,
                discount: flight.discount,
                price: flight.price,
                facilities: flight.facilities,
                duration: duration,
                classInfo: classInfo,
            };
        };

        const formattedFlight = formatFlight(flight);

        res.status(200).json({
            status: true,
            message: "Flight data retrieved successfully",
            data: formattedFlight,
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const counter = new Map();

const createFlight = async (req, res, next) => {
    const {
        planeId,
        departureDate,
        departureAirportId,
        transitArrivalDate,
        transitDepartureDate,
        transitAirportId,
        arrivalDate,
        destinationAirportId,
        capacity,
        price,
        discount,
        facilities,
    } = req.body;

    const departureDateTimeConvert = toWib(departureDate);
    const arrivalDateTimeConvert = toWib(arrivalDate);
    const transitArrivalDateTimeConvert = transitArrivalDate
        ? toWib(transitArrivalDate)
        : null;
    const transitDepartureDateTimeConvert = transitDepartureDate
        ? toWib(transitDepartureDate)
        : null;

    try {
        const plane = await prisma.airline.findUnique({
            where: { id: planeId },
        });
        const departureAirport = await prisma.airport.findUnique({
            where: { id: departureAirportId },
        });

        if (!plane || !departureAirport) {
            return next(
                createHttpError(400, {
                    message: "Invalid planeId or departureAirportId",
                })
            );
        }

        let finalPrice = price;
        if (discount) {
            finalPrice = price - price * (discount / 100);
        }

        const baseCode = `${plane.code}-${departureAirport.code}`;
        const lastNumber = counter.get(baseCode) || 0;
        const newNumber = lastNumber + 1;
        counter.set(baseCode, newNumber);

        const code = `${baseCode}-${newNumber}`;

        const newFlight = await prisma.flight.create({
            data: {
                planeId,
                departureDate: departureDateTimeConvert,
                departureAirportId,
                transitArrivalDate: transitArrivalDateTimeConvert,
                transitDepartureDate: transitDepartureDateTimeConvert,
                transitAirportId,
                arrivalDate: arrivalDateTimeConvert,
                destinationAirportId,
                capacity,
                discount,
                price: finalPrice,
                facilities,
                code,
            },
            include: {
                departureAirport: true,
                transitAirport: true,
                destinationAirport: true,
            },
        });
        res.status(201).json({
            status: true,
            message: "Flight created successfully",
            data: newFlight,
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const updateFlight = async (req, res, next) => {
    const {
        departureDate,
        departureAirportId,
        transitArrivalDate,
        transitDepartureDate,
        transitAirportId,
        arrivalDate,
        destinationAirportId,
        capacity,
        discount,
        price,
        facilities,
    } = req.body;

    const departureDateTimeConvert = toWib(departureDate);
    const arrivalDateTimeConvert = toWib(arrivalDate);
    const transitArrivalDateTimeConvert = transitArrivalDate
        ? toWib(transitArrivalDate)
        : null;
    const transitDepartureDateTimeConvert = transitDepartureDate
        ? toWib(transitDepartureDate)
        : null;

    let finalPrice = price;
    if (discount) {
        finalPrice = price - price * (discount / 100);
    }

    try {
        const flight = await prisma.flight.findUnique({
            where: { id: req.params.id },
        });

        if (!flight) {
            return next(
                createHttpError(404, {
                    message: "Flight Not Found",
                })
            );
        }

        const updatedFlight = await prisma.flight.update({
            where: { id: req.params.id },
            data: {
                planeId: flight.planeId,
                departureDate: departureDateTimeConvert,
                departureAirportId,
                transitArrivalDate: transitArrivalDateTimeConvert,
                transitDepartureDate: transitDepartureDateTimeConvert,
                transitAirportId,
                arrivalDate: arrivalDateTimeConvert,
                destinationAirportId,
                capacity,
                discount,
                price: finalPrice,
                facilities,
            },
            include: {
                departureAirport: true,
                transitAirport: true,
                destinationAirport: true,
            },
        });

        res.status(201).json({
            status: true,
            message: "Flight updated successfully",
            data: {
                beforeUpdate: flight,
                afterUpdate: updatedFlight,
            },
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const getFavoriteDestinations = async (req, res, next) => {
    try {
        const { continent } = req.query;
        const ticketTransactionDetails =
            await prisma.ticketTransactionDetail.findMany({
                include: {
                    flight: {
                        include: {
                            destinationAirport: true,
                            departureAirport: true,
                            plane: true,
                        },
                    },
                },
            });

        const destinationGroups = ticketTransactionDetails.reduce(
            (groups, transaction) => {
                const destinationAirportId =
                    transaction.flight.destinationAirportId;
                const flightId = transaction.flightId;

                const key = `${destinationAirportId}_${flightId}`;

                if (!groups[key]) {
                    groups[key] = {
                        airportId: destinationAirportId,
                        flight: transaction.flight,
                        transactionCount: 0,
                    };
                }

                groups[key].transactionCount++;

                return groups;
            },
            {}
        );

        const uniqueDestinations = Object.values(destinationGroups);

        uniqueDestinations.sort(
            (a, b) => b.transactionCount - a.transactionCount
        );

        let topDestinations = uniqueDestinations.slice(0, 5);

        if (continent) {
            topDestinations = topDestinations.filter(
                (destination) =>
                    destination.flight.destinationAirport.continent ===
                    continent
            );
        }

        const formattedDestinations = await Promise.all(
            topDestinations.map(async (destination) => {
                const flightDetails = {
                    flightId: destination.flight.id,
                    from: {
                        departureDate: formatDate(
                            destination.flight.departureDate
                        ),
                        departureTime: formatTime(
                            destination.flight.departureDate
                        ),
                        departureCity: destination.flight.departureAirport.city,
                        code: destination.flight.departureAirport.code,
                    },
                    to: {
                        arrivalDate: formatDate(destination.flight.arrivalDate),
                        arrivalTime: formatTime(destination.flight.arrivalDate),
                        arrivalCity: destination.flight.destinationAirport.city,
                        continent:
                            destination.flight.destinationAirport.continent,
                        code: destination.flight.destinationAirport.code,
                        image: destination.flight.destinationAirport.image,
                    },
                    plane: {
                        airline: destination.flight.plane.name,
                        price: destination.flight.price,
                        discount: destination.flight.discount,
                        terminal: destination.flight.plane.terminal,
                    },
                    transactionCount: destination.transactionCount,
                };

                return {
                    flightDetails,
                };
            })
        );

        res.status(200).json({
            status: true,
            message: "Favorite destinations retrieved successfully",
            data: formattedDestinations,
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

const removeFlight = async (req, res, next) => {
    try {
        const flight = await prisma.flight.findUnique({
            where: { id: req.params.id },
            include: {
                seats: true,
                tickets: true,
            },
        });

        if (!flight) {
            return next(
                createHttpError(409, {
                    message: "Flight Not Found",
                })
            );
        }

        if (flight.seats.length > 0 || flight.tickets.length > 0) {
            await prisma.ticket.deleteMany({
                where: { flightId: req.params.id },
            });

            await prisma.flightSeat.deleteMany({
                where: { flightId: req.params.id },
            });
        }

        const deletedFlight = await prisma.flight.delete({
            where: { id: req.params.id },
        });

        res.status(200).json({
            status: true,
            message: "Flight deleted successfully",
            deletedData: deletedFlight,
        });
    } catch (error) {
        next(createHttpError(500, { message: error.message }));
    }
};

module.exports = {
    getAllFlight,
    getFlightById,
    createFlight,
    removeFlight,
    updateFlight,
    getFavoriteDestinations,
};
