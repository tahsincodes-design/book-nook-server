import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 5000;

const client = new MongoClient(process.env.MONGODB_URI);
const books = client.db('booknook').collection('books');

app.use(
    cors({
        origin: process.env.BETTER_AUTH_URL,
        credentials: true,
    }),
);
app.use(express.json({ limit: '2mb' }));

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

app.post('/add-books', async (req, res) => {
    try {
        const body = req.body ?? {};
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const author = typeof body.author === 'string' ? body.author.trim() : '';
        const category =
            typeof body.category === 'string' ? body.category.trim() : '';

        if (!title || !author || !category) {
            return res
                .status(400)
                .json({ message: 'Title, author and category are required.' });
        }

        const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();
        const requestedCopies = Number(body.totalCopies);
        const totalCopies = Number.isFinite(requestedCopies)
            ? Math.max(0, Math.floor(requestedCopies))
            : 1;

        const book = {
            title,
            author,
            category,
            image: typeof body.image === 'string' ? body.image : '',
            description:
                typeof body.description === 'string' ? body.description : '',
            totalCopies,
            addedBy: {
                name: body.addedBy?.name ?? 'BookNook reader',
                email: body.addedBy?.email ?? '',
            },
            createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        };

        const result = await books.insertOne(book);

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

app.patch('/books/:id', async (req, res) => {
    try {
        const bookId = req.params.id;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        const { _id, ...updateData } = req.body ?? {};

        if (updateData.totalCopies !== undefined) {
            const copies = Number(updateData.totalCopies);
            updateData.totalCopies = Number.isFinite(copies)
                ? Math.max(0, Math.floor(copies))
                : 0;
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

app.delete('/books/:id', async (req, res) => {
    try {
        const bookId = req.params.id;

        if (!ObjectId.isValid(bookId)) {
            return res.status(400).json({ message: 'Invalid book ID' });
        }

        const result = await books.deleteOne({ _id: new ObjectId(bookId) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        res.status(200).json({ message: 'Book deleted successfully' });
    } catch (error) {
        console.error('Error deleting book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/borrows', async (req, res) => {
    const borrows = client.db('booknook').collection('borrows');

    try {
        const body = req.body ?? {};
        const bookId = typeof body.bookId === 'string' ? body.bookId : '';
        const email =
            typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';

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
            email,
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

app.get('/my-borrows/:email', async (req, res) => {
    try {
        const email = req.params.email.trim().toLowerCase();
        const collection = client.db('booknook').collection('borrows');
        const borrows = await collection
            .find({ email })
            .sort({ borrowedAt: -1 })
            .toArray();
        res.status(200).json(borrows);
    } catch (error) {
        console.error('Error fetching borrows:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/my-borrows/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid borrow ID',
            });
        }

        const collection = client
            .db('booknook')
            .collection('borrows');
        const borrowObjectId = new ObjectId(id);
        const borrow = await collection.findOne({ _id: borrowObjectId });

        if (!borrow) {
            return res.status(404).json({
                success: false,
                message: 'Borrow not found',
            });
        }

        const result = await collection.deleteOne({ _id: borrowObjectId });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Borrow not found',
            });
        }

        if (borrow.bookId && ObjectId.isValid(borrow.bookId)) {
            await books.updateOne(
                { _id: new ObjectId(borrow.bookId) },
                { $inc: { totalCopies: 1 } },
            );
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

app.post('/usersComments', async (req, res) => {
    try {
        const body = req.body ?? {};
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        const rawRating = body.rating ?? body.stars;
        const rating =
            typeof rawRating === 'number'
                ? rawRating
                : typeof rawRating === 'string'
                  ? Number(rawRating)
                  : NaN;

        if (!userId || !email || !comment || !Number.isInteger(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                message: 'User ID, email, comment and a rating from 1 to 5 are required',
            });
        }

        const usersCommentsCollection = client.db('booknook').collection('usersComments');
        await usersCommentsCollection.insertOne({
            userId,
            name: name || email.split('@')[0],
            email,
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

app.get('/usersComments', async (req, res) => {
    try {
        const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
        const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required',
            });
        }

        const usersCommentsCollection = client.db('booknook').collection('usersComments');
        const comments = await usersCommentsCollection
            .find({
                $or: [
                    { userId },
                    ...(email ? [{ userId: { $exists: false }, email }] : []),
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
