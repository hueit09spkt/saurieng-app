const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const mongoose = require('mongoose');
const app = express();
const port = process.env.PORT || 3000;

// Kết nối MongoDB Atlas
const MONGODB_URI = 'mongodb+srv://saurieng:saurieng123@cluster0.qpeveyo.mongodb.net/saurieng?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('✅ Kết nối MongoDB Atlas thành công!');
})
.catch((err) => {
    console.error('❌ Lỗi kết nối MongoDB:', err);
});

// Định nghĩa Schema
const gardenSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    rows: { type: Number, required: true },
    cols: { type: Number, required: true },
    created_at: { type: Date, default: Date.now }
});

const treeSchema = new mongoose.Schema({
    garden_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Garden', required: true },
    row: { type: Number, required: true },
    col: { type: Number, required: true },
    variety: { type: String, default: '' },
    status: { type: String, default: 'Khỏe mạnh' },
    notes: { type: String, default: '' },
    images: [{ type: String }],
    harvestInfo: [{ type: Object }],
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

// Tạo unique index cho garden_id + row + col
treeSchema.index({ garden_id: 1, row: 1, col: 1 }, { unique: true });

const Garden = mongoose.model('Garden', gardenSchema);
const Tree = mongoose.model('Tree', treeSchema);

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Hàm trợ giúp để đọc và ghi database MongoDB
const readGardens = async () => {
    try {
        const gardens = await Garden.find().sort({ created_at: -1 });
        const gardensWithTrees = [];
        
        for (const garden of gardens) {
            const trees = await Tree.find({ garden_id: garden._id });
            gardensWithTrees.push({
                id: garden._id,
                name: garden.name,
                rows: garden.rows,
                cols: garden.cols,
                created_at: garden.created_at,
                trees: trees.map(tree => ({
                    row: tree.row,
                    col: tree.col,
                    variety: tree.variety,
                    status: tree.status,
                    notes: tree.notes,
                    images: tree.images || [],
                    harvestInfo: tree.harvestInfo || []
                }))
            });
        }
        
        return gardensWithTrees;
    } catch (error) {
        console.error('Lỗi khi đọc gardens:', error);
        throw error;
    }
};

const writeGarden = async (gardenData) => {
    try {
        const garden = new Garden(gardenData);
        const savedGarden = await garden.save();
        return savedGarden._id;
    } catch (error) {
        console.error('Lỗi khi tạo garden:', error);
        throw error;
    }
};

const updateTree = async (gardenName, treeData) => {
    try {
        console.log('updateTree được gọi với:', { gardenName, treeData });
        
        const garden = await Garden.findOne({ name: gardenName });
        if (!garden) {
            console.log('Không tìm thấy garden:', gardenName);
            return false;
        }
        
        console.log('Sẽ lưu vào database:', {
            gardenId: garden._id,
            row: treeData.row,
            col: treeData.col,
            variety: treeData.variety,
            status: treeData.status,
            notes: treeData.notes,
            imagesCount: treeData.images ? treeData.images.length : 0,
            harvestInfoCount: treeData.harvestInfo ? treeData.harvestInfo.length : 0
        });
        
        // Sử dụng findOneAndUpdate với upsert để tạo mới hoặc cập nhật
        await Tree.findOneAndUpdate(
            { garden_id: garden._id, row: treeData.row, col: treeData.col },
            {
                garden_id: garden._id,
                row: treeData.row,
                col: treeData.col,
                variety: treeData.variety,
                status: treeData.status,
                notes: treeData.notes,
                images: treeData.images || [],
                harvestInfo: treeData.harvestInfo || [],
                updated_at: new Date()
            },
            { upsert: true, new: true }
        );
        
        console.log('Lưu tree thành công');
        return true;
    } catch (error) {
        console.error('Lỗi khi lưu tree:', error);
        throw error;
    }
};

const deleteGarden = async (gardenName) => {
    try {
        const garden = await Garden.findOne({ name: gardenName });
        if (!garden) {
            return false;
        }
        
        // Xóa tất cả trees của garden này
        await Tree.deleteMany({ garden_id: garden._id });
        
        // Xóa garden
        await Garden.findByIdAndDelete(garden._id);
        
        return true;
    } catch (error) {
        console.error('Lỗi khi xóa garden:', error);
        throw error;
    }
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

    try {
        const gardenId = await writeGarden(newGarden);
        res.status(201).json({ ...newGarden, id: gardenId });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'Tên vườn đã tồn tại.' });
        }
        throw error;
    }
}));

// Xóa vườn
app.delete('/api/gardens/:name', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const success = await deleteGarden(gardenName);

    if (!success) {
        return res.status(404).json({ error: 'Không tìm thấy vườn để xóa.' });
    }

    res.json({ success: true });
}));

// Cập nhật thông tin cây (JSON data)
app.post('/api/gardens/:name/trees/json', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const treeData = req.body;
    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận dữ liệu JSON từ client:', {
        gardenName,
        row,
        col,
        variety: treeData.variety,
        status: treeData.status,
        notes: treeData.notes,
        existingImagesLength: treeData.existingImages ? treeData.existingImages.length : 0,
        harvestInfoLength: treeData.harvestInfo ? treeData.harvestInfo.length : 0
    });

    const finalTreeData = {
        row,
        col,
        variety: treeData.variety || '',
        status: treeData.status || '',
        notes: treeData.notes || '',
        images: [], // Sẽ được cập nhật sau khi upload images
        harvestInfo: treeData.harvestInfo || []
    };

    console.log('Dữ liệu cuối cùng:', finalTreeData);

    try {
        const success = await updateTree(gardenName, finalTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Lỗi khi lưu cây:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu thông tin cây.' });
    }
}));

// Cập nhật hình ảnh cho cây
app.post('/api/gardens/:name/trees/images', upload.array('images', 10), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const row = parseInt(req.body.row, 10);
    const col = parseInt(req.body.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận hình ảnh từ client:', {
        gardenName,
        row,
        col,
        filesCount: req.files ? req.files.length : 0
    });

    // Lấy thông tin cây hiện tại từ MongoDB
    const garden = await Garden.findOne({ name: gardenName });
    if (!garden) {
        return res.status(404).json({ error: 'Không tìm thấy vườn.' });
    }

    const tree = await Tree.findOne({ garden_id: garden._id, row, col });
    
    // Thêm hình ảnh mới
    const uploadedImages = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    
    let updatedTreeData;
    if (tree) {
        // Cập nhật cây hiện có
        updatedTreeData = {
            row,
            col,
            variety: tree.variety,
            status: tree.status,
            notes: tree.notes,
            images: [...(tree.images || []), ...uploadedImages],
            harvestInfo: tree.harvestInfo || []
        };
    } else {
        // Tạo cây mới chỉ với hình ảnh
        updatedTreeData = {
            row,
            col,
            variety: '',
            status: 'Khỏe mạnh',
            notes: '',
            images: uploadedImages,
            harvestInfo: []
        };
    }

    console.log('Cập nhật tree với images:', {
        existingImagesCount: tree ? (tree.images || []).length : 0,
        newImagesCount: uploadedImages.length,
        totalImagesCount: updatedTreeData.images.length
    });

    try {
        const success = await updateTree(gardenName, updatedTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true, uploadedImages });
    } catch (error) {
        console.error('Lỗi khi lưu hình ảnh:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu hình ảnh.' });
    }
}));

// Cập nhật thông tin cây (legacy - giữ lại để tương thích)
app.post('/api/gardens/:name/trees', upload.array('images', 10), asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    const treeData = req.body;
    const row = parseInt(treeData.row, 10);
    const col = parseInt(treeData.col, 10);

    if (isNaN(row) || isNaN(col)) {
        return res.status(400).json({ error: 'Hàng hoặc cột không hợp lệ.' });
    }

    console.log('Nhận dữ liệu từ client:', {
        gardenName,
        row,
        col,
        variety: treeData.variety,
        status: treeData.status,
        notes: treeData.notes,
        existingImagesLength: treeData.existingImages ? treeData.existingImages.length : 0,
        harvestInfoLength: treeData.harvestInfo ? treeData.harvestInfo.length : 0,
        filesCount: req.files ? req.files.length : 0
    });

    // Xử lý nhiều hình ảnh
    const uploadedImages = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];
    
    // Xử lý existingImages an toàn hơn
    let existingImages = [];
    if (treeData.existingImages && treeData.existingImages !== 'undefined' && treeData.existingImages !== '[]') {
        try {
            existingImages = JSON.parse(treeData.existingImages);
        } catch (e) {
            console.log('Lỗi parse existingImages:', e);
            existingImages = [];
        }
    }
    
    const allImages = [...existingImages, ...uploadedImages];

    // Xử lý thông tin thu hoạch an toàn hơn
    let harvestInfo = [];
    if (treeData.harvestInfo && treeData.harvestInfo !== 'undefined' && treeData.harvestInfo !== '[]') {
        try {
            harvestInfo = JSON.parse(treeData.harvestInfo);
        } catch (e) {
            console.log('Lỗi parse harvestInfo:', e);
            harvestInfo = [];
        }
    }

    const finalTreeData = {
        row,
        col,
        variety: treeData.variety || '',
        status: treeData.status || '',
        notes: treeData.notes || '',
        images: allImages,
        harvestInfo
    };

    console.log('Dữ liệu cuối cùng:', finalTreeData);

    try {
        const success = await updateTree(gardenName, finalTreeData);
        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Lỗi khi lưu cây:', error);
        res.status(500).json({ error: 'Lỗi server khi lưu thông tin cây.' });
    }
}));

// Debug: Kiểm tra dữ liệu database MongoDB
app.get('/api/debug/gardens/:name', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    
    try {
        const garden = await Garden.findOne({ name: gardenName });
        if (!garden) {
            return res.json({ error: 'Không tìm thấy vườn' });
        }
        
        const trees = await Tree.find({ garden_id: garden._id });
        
        res.json({
            garden: {
                id: garden._id,
                name: garden.name,
                rows: garden.rows,
                cols: garden.cols,
                created_at: garden.created_at
            },
            trees: trees.map(tree => ({
                id: tree._id,
                garden_id: tree.garden_id,
                row: tree.row,
                col: tree.col,
                variety: tree.variety,
                status: tree.status,
                notes: tree.notes,
                images: tree.images,
                harvestInfo: tree.harvestInfo,
                created_at: tree.created_at,
                updated_at: tree.updated_at
            }))
        });
    } catch (error) {
        console.error('Lỗi debug:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
}));

// Gom nhóm cây theo tình trạng
app.get('/api/gardens/:name/grouped', asyncHandler(async (req, res) => {
    const gardenName = req.params.name;
    
    try {
        const garden = await Garden.findOne({ name: gardenName });
        if (!garden) {
            return res.status(404).json({ error: 'Không tìm thấy vườn.' });
        }
        
        const trees = await Tree.find({ garden_id: garden._id });
        const groupedTrees = trees.reduce((acc, tree) => {
            const status = tree.status || 'Không xác định';
            if (!acc[status]) acc[status] = [];
            acc[status].push(tree);
            return acc;
        }, {});
        
        res.json(groupedTrees);
    } catch (error) {
        console.error('Lỗi khi lấy grouped trees:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
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
        await fs.mkdir('./uploads', { recursive: true });
        
        // Đợi kết nối MongoDB
        await mongoose.connection.asPromise();
        
        // Kiểm tra xem có dữ liệu mẫu chưa
        const gardens = await readGardens();
        if (gardens.length === 0) {
            console.log('Tạo dữ liệu mẫu...');
            
            // Tạo vườn mẫu
            const gardenId = await writeGarden({
                name: "Vườn Mẫu",
                rows: 5,
                cols: 5
            });
            
            // Thêm cây mẫu
            const sampleTrees = [
                { row: 1, col: 1, status: "Khỏe mạnh", variety: "Ri6" },
                { row: 2, col: 2, status: "Sâu bệnh", variety: "Ri6" },
                { row: 3, col: 3, status: "Mới trồng", variety: "Chín Thơm" }
            ];
            
            for (const tree of sampleTrees) {
                await updateTree("Vườn Mẫu", tree);
            }
            
            console.log('✅ Đã tạo dữ liệu mẫu thành công!');
        }

        app.listen(port, () => {
            console.log(`🚀 Server chạy tại http://localhost:${port}`);
        });
    } catch (error) {
        console.error('❌ Không thể khởi động server:', error);
        process.exit(1);
    }
};
initialize();