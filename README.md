# UniGrades 🎓

UniGrades is a modern, responsive web application that allows students of the University of Patras to securely access, track, and visualize their academic grades. It features a beautiful, dark-mode-ready interface, offline support (PWA), and push notifications for new grades.

## Features ✨

*   **Grade Tracking**: View your complete academic history, organized by semester.
*   **Visual Analytics**: beautiful charts and gauges to visualize your performance (GPA, ECTS, pass/fail ratios).
*   **Offline Support**: Works offline as a Progressive Web App (PWA). Your grades are cached locally.
*   **Push Notifications**: Get notified instantly when a new grade is published.
*   **Dark Mode**: Seamless toggle between light and dark themes.
*   **Privacy First**: Your credentials are only used to fetch data directly from the university portal. Session cookies are stored locally on your device.

## Tech Stack 🛠️

### Client (Frontend)
*   **React**: UI Library
*   **TypeScript**: Type safety
*   **Vite**: Build tool & dev server
*   **Tailwind CSS**: Styling
*   **Framer Motion**: Animations
*   **Chart.js**: Data visualization
*   **Workbox**: Service Worker & PWA support

### Server (Backend)
*   **Node.js & Express**: API Server
*   **Puppeteer**: Headless browser automation for scraping the university portal (SAP).
*   **web-push**: Handling push notifications.

## Getting Started 🚀

### Prerequisites
*   Node.js (v18+)
*   npm or yarn

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/ImNotIcon/UniGrades.git
    cd UniGrades
    ```

2.  **Install dependencies:**
    ```bash
    # Install client dependencies
    cd client
    npm install

    # Install server dependencies
    cd ../server
    npm install
    ```

3.  **Environment Setup (Server):**
    Copy `.env.example` to `.env` in the `server` directory and fill in the values:
    ```env
    PORT=3001
    HEADLESS=true
    DEBUG_SCREENSHOTS=false

    # Required for Automatic Captcha Solving
    GEMINI_API_KEY=your_gemini_api_key

    # Push Notifications (VAPID Keys)
    VAPID_PUBLIC_KEY=your_public_key
    VAPID_PRIVATE_KEY=your_private_key
    VAPID_EMAIL=mailto:admin@example.com
    ```

4.  **Environment Setup (Client):**
    Copy `.env.example` to `.env` in the `client` directory:
    ```env
    VITE_API_URL=http://localhost:3001/api
    ```

5.  **Run the Application:**

    The easiest way to start both the client and server with automatic restarts and logging is to run the universal starter from the root directory:

    ```bash
    node start-all.js
    ```

    Alternatively, you can start them individually with managers (auto-restart + logging):

    *   **Start the Backend Manager:**
        ```bash
        cd server
        npm run serve
        ```

    *   **Start the Frontend Manager:**
        ```bash
        cd client
        npm run serve
        ```

5.  **Access the App:**
    Open your browser and navigate to `http://localhost:5173`.

## Usage 📱

1.  **Login**: Enter your University of Patras credentials (UPnet ID).
2.  **Captcha**: Solve the captcha presented from the university portal.
3.  **Dashboard**: View your grades, statistics, and history.
4.  **Notifications**: Click the bell icon to enable push notifications for new grades.
5.  **Offline**: Add the app to your home screen (PWA) to access your grades without an internet connection.

## License 📄

This project is licensed under the MIT License.
