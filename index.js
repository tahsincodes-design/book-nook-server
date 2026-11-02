import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

dotenv.config();
const app = express();
app.use(cors({
    origin: `${process.env.BETTER_AUTH_URL}`,
    credentials: true,
}));


const PORT = process.env.PORT;

app.get('/', (req, res) => {
    res.send('Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

app.post('/add-books', async (req, res) => {
    try {
        const book = req.body;
        const collection = client.db('booknook').collection('books');
        const result = await collection.insertOne(book);
        res.status(201).json({ message: 'Book added successfully', id: result.insertedId });
    } catch (error) {
        console.error('Error adding book:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});