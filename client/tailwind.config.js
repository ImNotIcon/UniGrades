/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                primary: '#0056b3', // University blue
                secondary: '#facc15', // Yellow accent
            }
        },
    },
    plugins: [],
}
