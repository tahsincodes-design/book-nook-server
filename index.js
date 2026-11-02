import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';

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
        const totalCopies = Number(body.totalCopies);

        const book = {
            title,
            author,
            category,
            image: typeof body.image === 'string' ? body.image : '',
            description:
                typeof body.description === 'string' ? body.description : '',
            totalCopies: Number.isFinite(totalCopies) ? totalCopies : 1,
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
        const book = await books.findOne({ _id: new MongoClient.ObjectId(bookId) });

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
        const updateData = req.body;

        const result = await books.updateOne(
            { _id: new MongoClient.ObjectId(bookId) },
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

        const result = await books.deleteOne({ _id: new MongoClient.ObjectId(bookId) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        res.status(200).json({ message: 'Book deleted successfully' });
    } catch (error) {
        console.error('Error deleting book:', error);
        res.status(500).json({ message: 'Internal server error' });
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
