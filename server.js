const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const app = express();
const port = process.env.PORT || 3000;

// Cấu hình Multer để lưu ảnh
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = 'uploads/';
        require('fs').mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Phục vụ file tĩnh từ thư mục public
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

// Tệp lưu trữ dữ liệu vườn
const dataFile = './data/gardens.json';

// Hàm trợ giúp để đọc và ghi file JSON một cách an toàn
const readGardens = async () => {
    try {
        const data = await fs.readFile(dataFile, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
};

const writeGardens = async (data) => {
    await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
};

// Hàm wrapper để xử lý lỗi trong các route async
const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Lấy danh sách vườn
app.get('/api/gardens', asyncHandler(async (req, res) => {
    const gardens = await readGardens();
    res.json(gardens);
}));

// Thêm vườn
app.post('/api/gardens', asyncHandler(async (req, res) => {
    const newGarden = req.body;
    if (!newGarden || !newGarden.name || !newGarden.rows || !newGarden.cols) {
        return res.status(400).json({ error: 'Dữ liệu vườn không hợp lệ.' });
    }

    const gardens = await readGardens();
    if (gardens.some(g => g.name === newGarden.name)) {
        return res.status(409).json({ error: 'Tên vườn đã tồn tại.' });
    }

    gardens.push(newGarden);
    await writeGardens(gardens);
    res.status(201).json(newGarden);
}));

// Xóa vườn
app.delete('/api/gardens/:name', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const gardens = await readGardens();
    const updatedGardens = gardens.filter(g => g.name !== gardenName);

    if (gardens.length === updatedGardens.length) {
        return res.status(404).json({ error: 'Không tìm thấy vườn để xóa.' });
    }

    await writeGardens(updatedGardens);
    res.json({ success: true });
}));

// Cập nhật thông tin cây
app.post('/api/gardens/:name/trees', upload.single('image'), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const gardens = await readGardens();
    const garden = gardens.find(g => g.name === gardenName);

    if (!garden) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    const treeData = req.body;
    treeData.image = req.file ? `/uploads/${req.file.filename}` : treeData.image || '';

    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    const treeIndex = garden.trees.findIndex(t => t.row === row && t.col === col);
    if (treeIndex >= 0) {
        garden.trees[treeIndex] = { ...treeData, row, col };
    } else {
        garden.trees.push({ ...treeData, row, col });
    }

    await writeGardens(gardens);
    res.json({ success: true });
}));

// Gom nhóm cây theo tình trạng
app.get('/api/gardens/:name/grouped', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const gardens = await readGardens();
    const garden = gardens.find(g => g.name === gardenName);

    if (!garden) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    const groupedTrees = garden.trees.reduce((acc, tree) => {
        const status = tree.status || 'Không xác định';
        if (!acc[status]) acc[status] = [];
        acc[status].push(tree);
        return acc;
    }, {});

    res.json(groupedTrees);
}));

// Tạo và tải file backup
app.get('/api/backup', (req, res, next) => {
    const backupFileName = 'backup.zip';
    const output = require('fs').createWriteStream(backupFileName);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        res.download(backupFileName, 'saurieng_backup.zip', (err) => {
            if (err) next(err);
            fs.unlink(backupFileName);
        });
    });

    archive.on('error', (err) => next(err));

    archive.file(dataFile, { name: 'gardens.json' });
    archive.directory('uploads/', 'uploads');
    archive.finalize();
});

// Middleware xử lý lỗi tập trung
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Đã có lỗi xảy ra ở server!');
});

// Khởi tạo các thư mục cần thiết và khởi động server
const initialize = async () => {
    try {
        await fs.mkdir('./data', { recursive: true });
        await fs.mkdir('./uploads', { recursive: true });
        await readGardens().then(gardens => {
            if (gardens.length === 0) {
                writeGardens([{
                    name: "Vườn Mẫu",
                    rows: 5,
                    cols: 5,
                    trees: [
                        { row: 1, col: 1, status: "Khỏe mạnh", variety: "Ri6" },
                        { row: 2, col: 2, status: "Sâu bệnh", variety: "Ri6" },
                        { row: 3, col: 3, status: "Mới trồng", variety: "Chín Thơm" }
                    ]
                }]);
            }
        });

        app.listen(port, () => {
            console.log(`Server chạy tại http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Không thể khởi động server:', error);
        process.exit(1);
    }
};
initialize();