import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 5000;
const authBaseUrl = process.env.BETTER_AUTH_URL;

if (!authBaseUrl) {
    throw new Error('BETTER_AUTH_URL must be set to the BetterAuth issuer URL.');
}

const authUrl = new URL(authBaseUrl);
const authIssuer = authUrl.href.replace(/\/+$/, '');
const authJwksUrl = new URL(
    process.env.AUTH_JWKS_URL ?? `${authIssuer}/api/auth/jwks`,
);
const jwtAudience = process.env.JWT_AUDIENCE ?? 'booknook-api';
const authJwks = createRemoteJWKSet(authJwksUrl);

const client = new MongoClient(process.env.MONGODB_URI);
const database = client.db(process.env.MONGODB_DB ?? 'booknook');
const books = database.collection('books');

app.use(
    cors({
        origin: authUrl.origin,
        credentials: true,
    }),
);
app.use(express.json({ limit: '2mb' }));

async function requireAuth(req, res, next) {
    const authorization = req.get('authorization') ?? '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);

    if (!match) {
        return res.status(401).json({ message: 'A valid bearer token is required.' });
    }

    try {
        const { payload } = await jwtVerify(match[1], authJwks, {
            issuer: authIssuer,
            audience: jwtAudience,
            algorithms: ['EdDSA'],
        });

        if (
            typeof payload.sub !== 'string' ||
            typeof payload.email !== 'string' ||
            typeof payload.name !== 'string'
        ) {
            return res.status(401).json({ message: 'The bearer token is invalid.' });
        }

        req.auth = {
            userId: payload.sub,
            email: payload.email.trim().toLowerCase(),
            name: payload.name.trim(),
        };
        return next();
    } catch (error) {
        console.error('JWT verification failed:', {
            name: error.name,
            code: error.code,
            claim: error.claim,
        });
        return res.status(401).json({ message: 'The bearer token is invalid or expired.' });
    }
}

function isBookOwner(book, user) {
    const owner = book?.addedBy ?? {};

    if (typeof owner.userId === 'string' && owner.userId) {
        return owner.userId === user.userId;
    }

    return (
        typeof owner.email === 'string' &&
        owner.email.trim().toLowerCase() === user.email
    );
}

app.get('/', (req, res) => {
    res.send('Server is running!');
});

app.get('/books', async (req, res) => {
    try {
        const allBooks = await books.find({}).sort({ createdAt: -1 }).toArray();
        res.status(200).json(allBooks);
    } catch (error) {
        console.error('Error fetching books:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/add-books', requireAuth, async (req, res) => {
    try {
        const body = req.body ?? {};
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const author = typeof body.author === 'string' ? body.author.trim() : '';
        const category =
            typeof body.category === 'string' ? body.category.trim() : '';
        const requestedCopies = Number(body.totalCopies);

        if (!title || !author || !category) {
            return res
                .status(400)
                .json({ message: 'Title, author and category are required.' });
        }

        if (
            !Number.isInteger(requestedCopies) ||
            requestedCopies < 0 ||
            requestedCopies > 100
        ) {
            return res.status(400).json({
                message: 'Copies must be a whole number between 0 and 100.',
            });
        }

        const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();

        const book = {
            title,
            author,
            category,
            image: typeof body.image === 'string' ? body.image : '',
            description:
                typeof body.description === 'string' ? body.description : '',
            totalCopies: requestedCopies,
            addedBy: {
                userId: req.auth.userId,
                name: req.auth.name || 'BookNook reader',
                email: req.auth.email,
            },
            createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        };

        const result = await books.insertOne(book);

        console.info('Book added:', {
            user: req.auth,
            book: { ...book, _id: result.insertedId },
        });

        res.status(201).json({
            message: 'Book added successfully',
            id: result.insertedId,
        });
    } catch (error) {
        console.error('Error adding book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/books/:id', async (req, res) => {
    try {
        const bookId = req.params.id;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        const book = await books.findOne({ _id: new ObjectId(bookId) });

        if (!book) {
            return res.status(404).json({ message: 'Book not found' });
        }

        res.status(200).json(book);
    } catch (error) {
        console.error('Error fetching book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.patch('/books/:id', requireAuth, async (req, res) => {
    try {
        const bookId = req.params.id;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        const existingBook = await books.findOne({ _id: new ObjectId(bookId) });

        if (!existingBook) {
            return res.status(404).json({ message: 'Book not found' });
        }

        if (!isBookOwner(existingBook, req.auth)) {
            return res.status(403).json({ message: 'You do not own this book.' });
        }

        const body = req.body ?? {};
        const allowedFields = [
            'title',
            'author',
            'category',
            'image',
            'description',
            'totalCopies',
        ];
        const updateData = Object.fromEntries(
            allowedFields
                .filter((field) => Object.hasOwn(body, field))
                .map((field) => [field, body[field]]),
        );

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ message: 'No valid book fields provided.' });
        }

        if (updateData.totalCopies !== undefined) {
            const copies = Number(updateData.totalCopies);

            if (!Number.isInteger(copies) || copies < 0) {
                return res.status(400).json({ message: 'Copies must be a non-negative whole number.' });
            }

            updateData.totalCopies = copies;
        }

        const result = await books.updateOne(
            { _id: new ObjectId(bookId) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        res.status(200).json({ message: 'Book updated successfully' });
    } catch (error) {
        console.error('Error updating book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/books/:id', requireAuth, async (req, res) => {
    try {
        const bookId = req.params.id;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        const book = await books.findOne({ _id: new ObjectId(bookId) });

        if (!book) {
            return res.status(404).json({ message: 'Book not found' });
        }

        if (!isBookOwner(book, req.auth)) {
            return res.status(403).json({ message: 'You do not own this book.' });
        }

        const result = await books.deleteOne({
            _id: new ObjectId(bookId),
            $or: [
                { 'addedBy.userId': req.auth.userId },
                {
                    'addedBy.userId': { $exists: false },
                    'addedBy.email': req.auth.email,
                },
            ],
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        res.status(200).json({ message: 'Book deleted successfully' });
    } catch (error) {
        console.error('Error deleting book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/borrows', requireAuth, async (req, res) => {
    const borrows = database.collection('borrows');

    try {
        const body = req.body ?? {};
        const bookId = typeof body.bookId === 'string' ? body.bookId : '';
        const { userId, email, name } = req.auth;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        if (!email) {
            return res.status(400).json({ message: 'A reader email is required.' });
        }

        const bookObjectId = new ObjectId(bookId);
        const book = await books.findOne({ _id: bookObjectId });

        if (!book) {
            return res.status(404).json({ message: 'Book not found' });
        }

        const alreadyBorrowed = await borrows.findOne({
            bookId: bookObjectId,
            $or: [
                { userId },
                { userId: { $exists: false }, email },
            ],
        });

        if (alreadyBorrowed) {
            return res
                .status(409)
                .json({ message: 'You have already borrowed this book.' });
        }

        if (!(book.totalCopies > 0)) {
            return res
                .status(409)
                .json({ message: 'No copies of this book are available right now.' });
        }

        const updatedBook = await books.findOneAndUpdate(
            { _id: bookObjectId, totalCopies: { $gt: 0 } },
            { $inc: { totalCopies: -1 } },
            { returnDocument: 'after' },
        );

        if (!updatedBook) {
            return res
                .status(409)
                .json({ message: 'No copies of this book are available right now.' });
        }

        try {
            const borrowedAt = new Date();
            const dueAt = new Date(borrowedAt);
            dueAt.setDate(dueAt.getDate() + 14);

            const result = await borrows.insertOne({
                bookId: bookObjectId,
                userId,
                email,
                name: name || book.addedBy?.name || 'BookNook reader',
                borrowedAt,
                dueAt,
            });

            return res.status(201).json({
                message: 'Book borrowed successfully',
                id: result.insertedId,
                totalCopies: updatedBook.totalCopies,
            });
        } catch (error) {
            // Put the copy back if the borrow record could not be written.
            await books.updateOne(
                { _id: bookObjectId },
                { $inc: { totalCopies: 1 } },
            );
            throw error;
        }
    } catch (error) {
        console.error('Error creating borrow:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/my-borrows/:email', requireAuth, async (req, res) => {
    try {
        const email = req.params.email.trim().toLowerCase();

        if (email !== req.auth.email) {
            return res.status(403).json({ message: 'You can only view your own loans.' });
        }

        const collection = database.collection('borrows');
        const borrows = await collection
            .find({
                $or: [
                    { userId: req.auth.userId },
                    { userId: { $exists: false }, email: req.auth.email },
                ],
            })
            .sort({ borrowedAt: -1 })
            .toArray();
        res.status(200).json(borrows);
    } catch (error) {
        console.error('Error fetching borrows:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/my-borrows/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid borrow ID',
            });
        }

        const collection = database.collection('borrows');
        const borrowObjectId = new ObjectId(id);
        const ownershipFilter = {
            _id: borrowObjectId,
            $or: [
                { userId: req.auth.userId },
                { userId: { $exists: false }, email: req.auth.email },
            ],
        };
        const borrow = await collection.findOne(ownershipFilter);

        if (!borrow) {
            return res.status(404).json({
                success: false,
                message: 'Borrow not found',
            });
        }

        const result = await collection.deleteOne(ownershipFilter);

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Borrow not found',
            });
        }

        if (borrow.bookId && ObjectId.isValid(borrow.bookId)) {
            const returnedBook = await books.updateOne(
                { _id: new ObjectId(borrow.bookId) },
                { $inc: { totalCopies: 1 } },
            );

            if (returnedBook.matchedCount === 0) {
                console.error(
                    `[booknook] Returned loan ${id} references missing book ${borrow.bookId}.`,
                );
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Book returned successfully',
        });
    } catch (error) {
        console.error('Error deleting borrow:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
});

app.post('/usersComments', requireAuth, async (req, res) => {
    try {
        const body = req.body ?? {};
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        const rawRating = body.rating ?? body.stars;
        const rating =
            typeof rawRating === 'number'
                ? rawRating
                : typeof rawRating === 'string'
                  ? Number(rawRating)
                  : NaN;

        if (
            !comment ||
            comment.length > 1000 ||
            !Number.isInteger(rating) ||
            rating < 1 ||
            rating > 5
        ) {
            return res.status(400).json({
                success: false,
                message: 'A comment of 1,000 characters or fewer and a rating from 1 to 5 are required.',
            });
        }

        const usersCommentsCollection = database.collection('usersComments');
        await usersCommentsCollection.insertOne({
            userId: req.auth.userId,
            name: req.auth.name || req.auth.email.split('@')[0],
            email: req.auth.email,
            comment,
            rating,
            createdAt: new Date(),
        });

        return res.status(201).json({
            success: true,
            message: 'Comment added successfully',
        });
    } catch (error) {
        console.error('Error adding comment:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
});

app.get('/usersComments', requireAuth, async (req, res) => {
    try {
        const requestedUserId =
            typeof req.query.userId === 'string' ? req.query.userId.trim() : '';

        if (requestedUserId && requestedUserId !== req.auth.userId) {
            return res.status(403).json({ message: 'You can only view your own comments.' });
        }

        const usersCommentsCollection = database.collection('usersComments');
        const comments = await usersCommentsCollection
            .find({
                $or: [
                    { userId: req.auth.userId },
                    {
                        userId: { $exists: false },
                        email: req.auth.email,
                    },
                ],
            })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json(comments);
    } catch (error) {
        console.error('Error fetching comments:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
});


async function start() {
    try {
        await client.connect();
        console.log('Connected to MongoDB');

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start the server:', error);
        process.exit(1);
    }
}

start();

export default app;
